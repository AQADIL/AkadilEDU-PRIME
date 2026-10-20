import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { config } from './config.js';
import { state, save, event } from './store.js';
import type { ApiCall, ModelPrices, ReferenceSource } from './schema.js';
import { calculateUsageCost, usageSchema } from './schema.js';

const responseSchema = z.object({
  id: z.string(),
  status: z.string(),
  service_tier: z.string().optional(),
  max_output_tokens: z.number().int().positive().nullish(),
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
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).nullable().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
}).passthrough();

export class BudgetError extends Error {}
export class RequestPausedError extends Error {}
export class RecoverableApiError extends Error {
  constructor(readonly callId: string, readonly reason: string) {
    super(`Запрос ${callId}: ${reason}. Задание отложено после ограниченного числа попыток.`);
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
    super(`OpenAI HTTP ${status}: ${message}`);
  }
}
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
  generation: 'Генерация', repair: 'Исправление', review: 'Проверка', research: 'Поиск источников',
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

export function estimateReservation(instructions: string, input: string, schema: object, kind: ApiCall['kind'] = 'generation',
  maxOutputTokens = config.maxOutputTokens, prices: ModelPrices = kind === 'review' ? config.reviewPrices : config.prices,
  webSearchMaxCalls = config.webSearchMaxCalls): number {
  const inputBound = Buffer.byteLength(instructions + input + JSON.stringify(schema), 'utf8') + 4096;
  if (inputBound > 200000) throw new Error('Input is too large for the configured pricing tier');
  const reservedInput = kind === 'research' ? Math.max(inputBound, config.webSearchInputTokenReserve) : inputBound;
  const toolFee = kind === 'research' ? webSearchMaxCalls * (prices.webSearch ?? config.webSearchPricePerCall) : 0;
  const maximumInputPrice = Math.max(prices.input, prices.cachedInput, prices.cacheWrite);
  return (reservedInput * maximumInputPrice + maxOutputTokens * prices.output) / 1000000 + toolFee;
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
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs = retryAfter === null ? undefined : /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    throw new HttpError(response.status, parsed.success ? parsed.data.error.message : 'Request failed',
      Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
  }
  return responseSchema.parse(await response.json());
}

function attemptNumber(call: ApiCall): number {
  const visited = new Set<string>();
  let current = call;
  let attempt = 1;
  while (current.retryOf) {
    if (visited.has(current.id)) throw new Error('Persisted API retry chain contains a cycle');
    visited.add(current.id);
    const parent = state.calls.find(item => item.id === current.retryOf);
    if (!parent || parent.retryCallId !== current.id || parent.kind !== call.kind) {
      throw new Error('Persisted API retry chain is inconsistent');
    }
    current = parent;
    attempt += 1;
  }
  if (call.attempt !== undefined && call.attempt !== attempt) throw new Error('Persisted API attempt number is inconsistent');
  return attempt;
}

function pendingRetry(call: ApiCall, kind: ApiCall['kind']): ApiCall {
  const visited = new Set<string>();
  let current = call;
  while (current.retryCallId) {
    if (visited.has(current.id)) throw new Error('Persisted API retry chain contains a cycle');
    visited.add(current.id);
    const child = state.calls.find(item => item.id === current.retryCallId);
    if (!child || child.retryOf !== current.id || child.kind !== kind || current.status !== 'settled') {
      throw new Error('Persisted API retry chain is inconsistent');
    }
    current = child;
  }
  attemptNumber(current);
  return current;
}

async function terminalFailure(call: ApiCall, reason: string, retryable: boolean) {
  call.terminalReason = reason;
  call.terminalRetryable = retryable;
  await event(`${callLabel(call.kind)}: ответ не принят (${reason}); учтено $${call.cost.toFixed(4)}.`, 'warning');
}

export async function runStructured<T>(kind: ApiCall['kind'], instructions: string, input: object,
  schema: z.ZodType<T>, onReserved: (id: string) => void, existingCallId?: string,
  shouldPause?: () => boolean): Promise<{
    data: T; responseId: string; callId: string; model: string;
    sources: ReferenceSource[]; webSearchCalls: number; webToolCalls: number;
  }> {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  const inputText = JSON.stringify(input);
  let call = existingCallId ? state.calls.find(item => item.id === existingCallId) : undefined;
  if (existingCallId && !call) throw new Error('Persisted API request is missing; automatic paid retry is disabled');
  if (call && call.kind !== kind) throw new Error('Persisted API request kind does not match the requested operation');
  if (call) {
    call = pendingRetry(call, kind);
    if (call.id !== existingCallId) {
      onReserved(call.id);
      await save();
    }
  }
  for (;;) {
    if (call?.status === 'settled' && call.result !== undefined) {
      const result = schema.safeParse(normalizeGenerationResult(kind, call.result));
      if (result.success) {
        if (!call.responseId) throw new Error('Settled API result is missing its response ID');
        return {
          data: result.data, responseId: call.responseId, callId: call.id, model: call.model,
          sources: call.toolSources || [], webSearchCalls: call.webSearchCalls || 0, webToolCalls: call.webToolCalls || 0,
        };
      }
      delete call.result;
      await terminalFailure(call, 'invalid_structured_result', true);
    }
    if (call?.status === 'uncertain' || (call && !call.responseId)) {
      throw new Error('Неопределённый результат API-запроса. Резерв сохранён; повторная оплата автоматически запрещена.');
    }
    const previous = call?.terminalReason ? call : undefined;
    if (previous && (previous.status !== 'settled' || !previous.terminalRetryable
      || attemptNumber(previous) >= config.apiMaxAttempts)) {
      if (previous.status !== 'settled') throw new Error('Unsettled API response cannot be retried');
      throw new RecoverableApiError(previous.id, previous.terminalReason!);
    }
    if (!call || previous) {
      if (previous && ['server_error', 'rate_limit_exceeded', 'vector_store_timeout'].includes(previous.terminalReason!)) {
        await delay(Math.min(2000 * 2 ** (attemptNumber(previous) - 1), 30000));
      }
      if (shouldPause?.()) throw new RequestPausedError('Пауза запрошена до следующего API-запроса.');
      if (kind === 'research' && !config.webSearchEnabled) throw new Error('Web research is disabled');
      const previousLimit = previous?.maxOutputTokens ?? config.maxOutputTokens;
      const maxOutputTokens = previous?.terminalReason === 'max_output_tokens'
        ? Math.min(config.retryMaxOutputTokens, Math.max(previousLimit + 1, previousLimit * 2))
        : previousLimit;
      const prices = previous?.prices ?? {
        ...(kind === 'review' ? config.reviewPrices : config.prices),
        ...(kind === 'research' ? { webSearch: config.webSearchPricePerCall } : {}),
      };
      const webSearchMaxCalls = previous?.webSearchMaxCalls ?? config.webSearchMaxCalls;
      const reserved = estimateReservation(instructions, inputText, jsonSchema, kind, maxOutputTokens, prices, webSearchMaxCalls);
      if (state.budget.spent + state.budget.reserved + reserved > state.budget.limit) {
        throw new BudgetError('Оставшегося бюджета недостаточно для безопасного резерва следующего запроса.');
      }
      call = {
        id: randomUUID(), kind, model: previous?.model ?? (kind === 'review' ? config.reviewModel : config.model),
        serviceTier: previous?.serviceTier ?? config.serviceTier, prices: { ...prices },
        maxOutputTokens, attempt: previous ? attemptNumber(previous) + 1 : 1,
        ...(previous ? {
          retryOf: previous.id,
          ...(previous.referenceSources ? { referenceSources: previous.referenceSources } : {}),
          ...(previous.researchResponseId ? { researchResponseId: previous.researchResponseId } : {}),
        } : {}),
        ...(kind === 'research' ? { webSearchMaxCalls } : {}),
        status: 'reserved', reserved, cost: 0,
      };
      state.calls.push(call);
      if (previous) previous.retryCallId = call.id;
      onReserved(call.id);
      await save();
      if (previous) {
        await event(`${callLabel(kind)}: автоматическая попытка ${call.attempt}/${config.apiMaxAttempts}, причина: ${previous.terminalReason}. Лимит ответа: ${maxOutputTokens}.`);
      }
      try {
        const created = await request('/responses', {
          model: call.model, service_tier: call.serviceTier, instructions, input: inputText,
          reasoning: { effort: config.reasoningEffort },
          text: { format: { type: 'json_schema', name: kind, strict: true, schema: jsonSchema } },
          max_output_tokens: maxOutputTokens, background: true, store: true,
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
    let response: z.infer<typeof responseSchema>;
    for (;;) {
      try {
        const include = kind === 'research' ? '?include%5B%5D=web_search_call.action.sources' : '';
        response = await request(`/responses/${encodeURIComponent(call.responseId!)}${include}`);
        pollFailures = 0;
      } catch (error) {
        const transient = error instanceof HttpError
          ? error.status === 408 || error.status === 429 || error.status >= 500
          : error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
        pollFailures += 1;
        if (!transient || pollFailures >= 12 || (error instanceof HttpError && (error.retryAfterMs ?? 0) > 60000)) throw error;
        if (shouldPause?.()) throw new RequestPausedError('Получение ответа отложено до продолжения работы.');
        const wait = Math.max(Math.min(2000 * 2 ** (pollFailures - 1), 30000),
          error instanceof HttpError ? error.retryAfterMs ?? 0 : 0);
        await event(`OpenAI временно недоступен; получение уже оплаченного ответа будет повторено через ${Math.ceil(wait / 1000)} с.`, 'warning');
        await delay(wait);
        continue;
      }
      if (response.status !== 'queued' && response.status !== 'in_progress') break;
      if (Date.now() - lastProgress >= 30000) {
        await event(response.status === 'queued' ? 'Запрос находится в очереди OpenAI.'
          : `OpenAI: ${callLabel(kind).toLowerCase()}. Токены будут учтены после ответа.`);
        lastProgress = Date.now();
      }
      await delay(2000);
    }
    if (response.id !== call.responseId) throw new Error('OpenAI returned a different response ID; its charge must be reconciled');
    if (call.serviceTier && response.service_tier && response.service_tier !== call.serviceTier) {
      call.status = 'uncertain';
      await save();
      throw new Error('OpenAI returned an unexpected service tier; its charge must be reconciled before continuing');
    }
    const web = webUsage(response);
    call.maxOutputTokens ??= response.max_output_tokens ?? config.maxOutputTokens;
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
    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason || 'incomplete_response';
      await terminalFailure(call, reason, reason === 'max_output_tokens');
      continue;
    }
    if (response.status === 'failed' || response.status === 'cancelled') {
      const reason = response.error?.code || response.status;
      await terminalFailure(call, reason, ['server_error', 'rate_limit_exceeded', 'vector_store_timeout'].includes(reason));
      continue;
    }
    if (response.status !== 'completed') throw new Error(`OpenAI returned unknown response status: ${response.status}`);
    const content = response.output?.flatMap(output => output.content || []) ?? [];
    if (content.some(item => item.type === 'refusal')) {
      await terminalFailure(call, 'refusal', false);
      continue;
    }
    const text = content.filter(item => item.type === 'output_text').map(item => item.text || '').join('');
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch {
      await terminalFailure(call, 'invalid_json', true);
      continue;
    }
    const validated = schema.safeParse(normalizeGenerationResult(kind, parsed));
    if (!validated.success) {
      await terminalFailure(call, 'invalid_structured_result', true);
      continue;
    }
    call.result = validated.data;
    await save();
    await event(`${callLabel(kind)}: ${call.outputTokens || 0} выходных токенов, $${call.cost.toFixed(4)}.`);
    return {
      data: validated.data, responseId: response.id, callId: call.id, model: call.model,
      sources: call.toolSources, webSearchCalls: call.webSearchCalls, webToolCalls: call.webToolCalls,
    };
  }
}
