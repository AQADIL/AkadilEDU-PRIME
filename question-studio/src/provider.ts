import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { config } from './config.js';
import { state, save, event } from './store.js';
import type { ApiCall } from './schema.js';

const responseSchema = z.object({
  id: z.string(),
  status: z.string(),
  output: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
  usage: z.object({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
    input_tokens_details: z.object({ cached_tokens: z.number().nonnegative().optional() }).optional(),
    output_tokens_details: z.object({ reasoning_tokens: z.number().nonnegative().optional() }).optional(),
  }).nullable().optional(),
  error: z.object({ message: z.string().optional() }).nullable().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
}).passthrough();

export class BudgetError extends Error {}
export function estimateReservation(instructions: string, input: string, schema: object): number {
  const inputBound = Buffer.byteLength(instructions + input + JSON.stringify(schema), 'utf8') + 4096;
  if (inputBound > 200000) throw new Error('Input is too large for the configured pricing tier');
  return (inputBound * config.inputPrice + config.maxOutputTokens * config.outputPrice) / 1000000;
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
  schema: z.ZodType<T>, onReserved: (id: string) => void, existingCallId?: string): Promise<{ data: T; responseId: string; callId: string }> {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  const inputText = JSON.stringify(input);
  let call = existingCallId ? state.calls.find(c => c.id === existingCallId) : undefined;
  if (call?.status === 'settled' && call.result !== undefined) {
    return { data: schema.parse(call.result), responseId: call.responseId!, callId: call.id };
  }
  if (call?.status === 'uncertain' || (call && !call.responseId)) {
    throw new Error('Неопределённый результат API-запроса. Резерв сохранён; повторная оплата автоматически запрещена.');
  }
  if (!call) {
    const reserved = estimateReservation(instructions, inputText, jsonSchema);
    if (state.budget.spent + state.budget.reserved + reserved > state.budget.limit) {
      throw new BudgetError('Оставшегося бюджета недостаточно для безопасного резерва следующего запроса.');
    }
    call = { id: randomUUID(), kind, status: 'reserved', reserved, cost: 0 };
    state.calls.push(call);
    onReserved(call.id);
    await save();
    try {
      const created = await request('/responses', {
        model: config.model, instructions, input: inputText,
        reasoning: { effort: config.reasoningEffort },
        text: { format: { type: 'json_schema', name: kind, strict: true, schema: jsonSchema } },
        max_output_tokens: config.maxOutputTokens, background: true, store: true,
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
      response = await request(`/responses/${encodeURIComponent(call.responseId!)}`);
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
          : `OpenAI обрабатывает ${kind === 'generation' ? 'генерацию' : 'независимую проверку'}. Токены будут учтены после ответа.`);
        lastProgress = Date.now();
      }
      await delay(2000);
      continue;
    }
    if (response.usage) {
      const usage = response.usage;
      const cached = Math.min(usage.input_tokens, usage.input_tokens_details?.cached_tokens || 0);
      call.cost = ((usage.input_tokens - cached) * config.inputPrice + cached * config.cachedInputPrice
        + usage.output_tokens * config.outputPrice) / 1000000;
      call.inputTokens = usage.input_tokens;
      call.outputTokens = usage.output_tokens;
      call.reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;
      call.status = 'settled';
    } else {
      call.status = 'uncertain';
    }
    await save();
    if (response.status !== 'completed') {
      throw new Error(`OpenAI ${response.status}: ${response.error?.message || response.incomplete_details?.reason || 'no completed result'}`);
    }
    const text = response.output?.flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text || '').join('');
    if (!text) throw new Error('OpenAI returned no structured result');
    const data = schema.parse(JSON.parse(text));
    call.result = data;
    await save();
    await event(`${kind === 'generation' ? 'Генерация' : 'Проверка'}: ${call.outputTokens || 0} выходных токенов, $${call.cost.toFixed(4)}.`);
    return { data, responseId: response.id, callId: call.id };
  }
}
