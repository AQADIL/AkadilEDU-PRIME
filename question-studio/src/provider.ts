import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { config } from './config.js';
import { state, save, event } from './store.js';
import type { ApiCall, ReferenceSource } from './schema.js';
import { calculateUsageCost, usageSchema } from './schema.js';

const responseSchema = z.object({
  id: z.string(),
  status: z.string(),
  service_tier: z.string().optional(),
  output: z.array(z.object({
    type: z.string(),
    status: z.string().optional(),
    action: z.object({
      type: z.string(),
      url: z.string().nullish(),
      sources: z.array(z.object({ type: z.string(), url: z.string(), title: z.string().optional() }).passthrough()).optional(),
    }).passthrough().nullish(),
    content: z.array(z.object({
      type: z.string(), text: z.string().optional(),
      annotations: z.array(z.object({
        type: z.string(), url: z.string().optional(), title: z.string().optional(),
      }).passthrough()).optional(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
  usage: usageSchema.nullable().optional(),
  error: z.object({ message: z.string().optional() }).nullable().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
}).passthrough();

export class BudgetError extends Error {}
export function sourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function webUsage(response: z.infer<typeof responseSchema>) {
  const calls = (response.output || []).filter(output => output.type === 'web_search_call');
  const sources = new Map<string, ReferenceSource>();
  for (const call of calls) {
    if (call.status !== 'completed') continue;
    for (const source of call.action?.sources || []) {
      const url = source.type === 'url' ? sourceUrl(source.url) : null;
      if (url) sources.set(url, { url, title: source.title?.trim().slice(0, 300) || new URL(url).hostname });
    }
    const opened = call.action?.type === 'open_page' ? sourceUrl(call.action.url) : null;
    if (opened && !sources.has(opened)) sources.set(opened, { url: opened, title: new URL(opened).hostname });
  }
  for (const content of (response.output || []).flatMap(output => output.content || [])) {
    for (const annotation of content.annotations || []) {
      const url = annotation.type === 'url_citation' ? sourceUrl(annotation.url) : null;
      if (url && sources.has(url) && annotation.title?.trim()) {
        sources.set(url, { url, title: annotation.title.trim().slice(0, 300) });
      }
    }
  }
  return {
    webToolCalls: calls.length,
    webSearchCalls: calls.filter(call => call.action?.type === 'search').length,
    toolSources: [...sources.values()],
  };
}

const callLabel = (kind: ApiCall['kind']) => ({
  generation: 'Генерация', review: 'Проверка', research: 'Поиск источников',
})[kind];

function normalizeGenerationResult(kind: ApiCall['kind'], value: unknown): unknown {
  if (kind !== 'generation' || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.questions)) return value;
  return {
    ...result,
    questions: result.questions.map((question: unknown) => {
      if (!question || typeof question !== 'object' || Array.isArray(question)) return question;
      const record = question as Record<string, unknown>;
      if (!record.diagram || typeof record.diagram !== 'object' || Array.isArray(record.diagram)) return question;
      const diagram = record.diagram as Record<string, unknown>;
      return { ...record, diagram: {
        ...diagram,
        ...(!Object.hasOwn(diagram, 'arcs') ? { arcs: [] } : {}),
        ...(!Object.hasOwn(diagram, 'angles') ? { angles: [] } : {}),
      } };
    }),
  };
}

export function estimateReservation(instructions: string, input: string, schema: object, kind: ApiCall['kind'] = 'generation'): number {
  const prices = kind === 'review' ? config.reviewPrices : config.prices;
  const inputBound = Buffer.byteLength(instructions + input + JSON.stringify(schema), 'utf8') + 4096;
  if (inputBound > 200000) throw new Error('Input is too large for the configured pricing tier');
  const reservedInput = kind === 'research' ? Math.max(inputBound, config.webSearchInputTokenReserve) : inputBound;
  const toolFee = kind === 'research' ? config.webSearchMaxCalls * config.webSearchPricePerCall : 0;
  const maximumInputPrice = Math.max(prices.input, prices.cachedInput, prices.cacheWrite);
  return (reservedInput * maximumInputPrice + config.maxOutputTokens * prices.output) / 1000000 + toolFee;
}

async function request(endpoint: string, body?: object) {
  const response = await fetch(`${config.apiBase}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(data);
    throw new Error(`OpenAI HTTP ${response.status}: ${parsed.success ? parsed.data.error.message : 'Request failed'}`);
  }
  return responseSchema.parse(await response.json());
}

export async function runStructured<T>(kind: ApiCall['kind'], instructions: string, input: object,
  schema: z.ZodType<T>, onReserved: (id: string) => void, existingCallId?: string): Promise<{
    data: T; responseId: string; callId: string; model: string;
    sources: ReferenceSource[]; webSearchCalls: number; webToolCalls: number;
  }> {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  const inputText = JSON.stringify(input);
  let call = existingCallId ? state.calls.find(c => c.id === existingCallId) : undefined;
  if (existingCallId && !call) throw new Error('Persisted API request is missing; automatic paid retry is disabled');
  if (call && call.kind !== kind) throw new Error('Persisted API request kind does not match the requested operation');
  if (call?.status === 'settled' && call.result !== undefined) {
    return {
      data: schema.parse(normalizeGenerationResult(kind, call.result)),
      responseId: call.responseId!, callId: call.id, model: call.model,
      sources: call.toolSources || [], webSearchCalls: call.webSearchCalls || 0, webToolCalls: call.webToolCalls || 0,
    };
  }
  if (call?.status === 'uncertain' || (call && !call.responseId)) {
    throw new Error('Неопределённый результат API-запроса. Резерв сохранён; повторная оплата автоматически запрещена.');
  }
  if (!call) {
    if (kind === 'research' && !config.webSearchEnabled) throw new Error('Web research is disabled');
    const reserved = estimateReservation(instructions, inputText, jsonSchema, kind);
    if (state.budget.spent + state.budget.reserved + reserved > state.budget.limit) {
      throw new BudgetError('Оставшегося бюджета недостаточно для безопасного резерва следующего запроса.');
    }
    call = {
      id: randomUUID(), kind, model: kind === 'review' ? config.reviewModel : config.model, serviceTier: config.serviceTier,
      prices: { ...(kind === 'review' ? config.reviewPrices : config.prices),
        ...(kind === 'research' ? { webSearch: config.webSearchPricePerCall } : {}) },
      ...(kind === 'research' ? { webSearchMaxCalls: config.webSearchMaxCalls } : {}),
      status: 'reserved', reserved, cost: 0,
    };
    state.calls.push(call);
    onReserved(call.id);
    await save();
    try {
      const created = await request('/responses', {
        model: call.model, service_tier: call.serviceTier, instructions, input: inputText,
        reasoning: { effort: config.reasoningEffort },
        text: { format: { type: 'json_schema', name: kind, strict: true, schema: jsonSchema } },
        max_output_tokens: config.maxOutputTokens, background: true, store: true,
        ...(kind === 'research' ? {
          tools: [{ type: 'web_search', search_context_size: 'low' }],
          max_tool_calls: call.webSearchMaxCalls,
          include: ['web_search_call.action.sources'],
        } : {}),
      });
      call.responseId = created.id;
      call.status = 'pending';
      await save();
    } catch (error) {
      call.status = 'uncertain';
      await save();
      throw error;
    }
  }
  let pollFailures = 0;
  let lastProgress = Date.now();
  for (;;) {
    let response: z.infer<typeof responseSchema>;
    try {
      const include = kind === 'research' ? '?include%5B%5D=web_search_call.action.sources' : '';
      response = await request(`/responses/${encodeURIComponent(call.responseId!)}${include}`);
      pollFailures = 0;
    } catch (error) {
      pollFailures += 1;
      if (pollFailures >= 5) throw error;
      await delay(Math.min(pollFailures * 3000, 15000));
      continue;
    }
    if (response.status === 'queued' || response.status === 'in_progress') {
      if (Date.now() - lastProgress >= 30000) {
        await event(response.status === 'queued' ? 'Запрос находится в очереди OpenAI.'
          : `OpenAI: ${callLabel(kind).toLowerCase()}. Токены будут учтены после ответа.`);
        lastProgress = Date.now();
      }
      await delay(2000);
      continue;
    }
    if (call.serviceTier && response.service_tier && response.service_tier !== call.serviceTier) {
      call.status = 'uncertain';
      await save();
      throw new Error('OpenAI returned an unexpected service tier; its charge must be reconciled before continuing');
    }
    const web = webUsage(response);
    call.webSearchCalls = web.webSearchCalls;
    call.webToolCalls = web.webToolCalls;
    call.toolSources = web.toolSources;
    if (response.usage && call.status !== 'settled') {
      try {
        Object.assign(call, calculateUsageCost(response.usage, call.prices, web.webSearchCalls));
      } catch (error) {
        call.status = 'uncertain';
        await save();
        throw error;
      }
      call.status = 'settled';
    } else if (call.status !== 'settled') {
      call.status = 'uncertain';
    }
    await save();
    if (call.status !== 'settled') {
      throw new Error('OpenAI returned no usage; the reservation is retained until accounting can be reconciled');
    }
    if (kind === 'research' && web.webToolCalls > call.webSearchMaxCalls!) {
      throw new Error('OpenAI exceeded the reserved web-tool call limit; further generation is stopped');
    }
    if (response.status !== 'completed') {
      throw new Error(`OpenAI ${response.status}: ${response.error?.message || response.incomplete_details?.reason || 'no completed result'}`);
    }
    const text = response.output?.flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text || '').join('');
    if (!text) throw new Error('OpenAI returned no structured result');
    const data = schema.parse(normalizeGenerationResult(kind, JSON.parse(text)));
    call.result = data;
    await save();
    await event(`${callLabel(kind)}: ${call.outputTokens || 0} выходных токенов, $${call.cost.toFixed(4)}.`);
    return {
      data, responseId: response.id, callId: call.id, model: call.model,
      sources: call.toolSources, webSearchCalls: call.webSearchCalls, webToolCalls: call.webToolCalls,
    };
  }
}
