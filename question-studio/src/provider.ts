import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { config } from './config.js';
import { budgetUsage, canReserve } from './budget.js';
import { state, save, event } from './store.js';
import type { ApiCall, ModelPrices, ReferenceSource } from './schema.js';
import { assertSettledCallWithinReservation, calculateUsageCost, exceededWebSearchLimit, restoreGeneratedQuestion, usageSchema } from './schema.js';

const responseSchema = z.object({
  id: z.string(),
  status: z.string(),
  service_tier: z.string().nullish(),
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
export class UnidentifiedApiOutcomeError extends Error {
  constructor(readonly callId: string) {
    super('Расход запроса не подтверждён. Полный резерв сохранён; этот запрос не повторяется.');
  }
}
export class ResponsePollingError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('OpenAI временно недоступен. Сохранённый ответ будет получен после восстановления связи без нового платного запроса.');
  }
}
export class RecoverableApiError extends Error {
  constructor(readonly callId: string, readonly reason: string) {
    super(`Запрос ${callId}: ${reason}. Задание отложено после ограниченного числа попыток.`);
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number, readonly code?: string,
    readonly requestId?: string) {
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

const activeCreations = new Set<string>();
let admissionAfter = 0;
let admissions = Promise.resolve();
let creationHealth: 'unverified' | 'ready' | 'blocked' = 'unverified';
let creationFailure: string | undefined;
function admitRequest<T>(operation: () => Promise<T>): Promise<T> {
  const result = admissions.then(operation);
  admissions = result.then(() => undefined, () => undefined);
  return result;
}

function normalizeGenerationResult(kind: ApiCall['kind'], value: unknown): unknown {
  if ((kind !== 'generation' && kind !== 'repair') || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  const normalizeQuestion = (question: unknown): unknown => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) return question;
    const record = question as Record<string, unknown>;
    const diagram = record.diagram && typeof record.diagram === 'object' && !Array.isArray(record.diagram)
      ? record.diagram as Record<string, unknown> : undefined;
    const normalized = diagram ? { ...record, diagram: {
      ...diagram,
      ...(!Object.hasOwn(diagram, 'arcs') ? { arcs: [] } : {}),
      ...(!Object.hasOwn(diagram, 'angles') ? { angles: [] } : {}),
    } } : question;
    try { return restoreGeneratedQuestion(normalized); }
    catch { return normalized; }
  };
  if (kind === 'repair') return { ...result, question: normalizeQuestion(result.question) };
  return Array.isArray(result.questions)
    ? { ...result, questions: result.questions.map(normalizeQuestion) } : value;
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

async function streamedResponse(response: Response, onResponseId?: (id: string) => Promise<void>) {
  if (!response.body) throw new Error('OpenAI returned an empty event stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let responseId: string | undefined;
  const consume = async (frame: string) => {
    const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (!payload || payload === '[DONE]') return;
    const item = z.object({ type: z.string(), response: z.unknown().optional(),
      message: z.string().optional() }).parse(JSON.parse(payload) as unknown);
    if (item.type === 'error') throw new Error(item.message ?? 'OpenAI stream failed');
    if (item.response === undefined) return;
    const identity = z.object({ id: z.string().min(1) }).parse(item.response);
    if (responseId && responseId !== identity.id) throw new Error('OpenAI stream changed its response ID');
    if (!responseId) {
      responseId = identity.id;
      await onResponseId?.(responseId);
    }
    if (['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(item.type)) {
      return responseSchema.parse(item.response);
    }
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 16 * 1024 * 1024) throw new Error('OpenAI event exceeded the response size limit');
      let separator: RegExpMatchArray | null;
      while ((separator = buffer.match(/\r?\n\r?\n/))) {
        const position = separator.index!;
        const frame = buffer.slice(0, position);
        buffer = buffer.slice(position + separator[0].length);
        const result = await consume(frame);
        if (result) return result;
      }
      if (chunk.done) {
        const result = await consume(buffer);
        if (result) return result;
        throw new Error('OpenAI stream ended before its terminal response');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function request(endpoint: string, body?: object, clientRequestId?: string,
  onResponseId?: (id: string) => Promise<void>) {
  const response = await fetch(`${config.apiBase}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json',
      ...(body && 'service_tier' in body && body.service_tier === 'ultrafast' ? { 'OpenAI-Service-Tier': 'ultrafast' } : {}),
      ...(clientRequestId ? { 'X-Client-Request-Id': clientRequestId } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(config.apiTimeoutMs),
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const parsed = z.object({ error: z.object({ message: z.string(), code: z.string().nullish() }) }).safeParse(data);
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs = retryAfter === null ? undefined : /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    throw new HttpError(response.status, parsed.success ? parsed.data.error.message : 'Request failed',
      Number.isFinite(retryAfterMs) ? retryAfterMs : undefined, parsed.success ? parsed.data.error.code ?? undefined : undefined,
      response.headers.get('x-request-id') ?? undefined);
  }
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return streamedResponse(response, onResponseId);
  }
  const data: unknown = await response.json();
  const identity = z.object({ id: z.string().min(1) }).safeParse(data);
  if (identity.success && onResponseId) await onResponseId(identity.data.id);
  return responseSchema.parse(data);
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

function quarantineMissingUsage(call: ApiCall, response: z.infer<typeof responseSchema>) {
  call.status = 'uncertain';
  call.quarantined = true;
  call.terminalReason = `usage_unavailable:${response.error?.code ?? response.status}`;
  call.terminalRetryable = true;
}

export async function reconcileUncertainResponses(shouldPause: () => boolean): Promise<void> {
  for (const call of state.calls.filter(item => item.status === 'uncertain' && item.responseId && !item.quarantined)) {
    while (!shouldPause()) {
      let response: z.infer<typeof responseSchema>;
      try { response = await request(`/responses/${encodeURIComponent(call.responseId!)}`); }
      catch (error) {
        if (error instanceof HttpError && error.status !== 408 && error.status !== 429 && error.status < 500) throw error;
        await event('Проверяю расход сохранённого ответа после сбоя связи. Нового платного запроса нет.', 'warning');
        await delay(Math.max(config.recoveryBackoffMs, error instanceof HttpError ? error.retryAfterMs ?? 0 : 0));
        continue;
      }
      if (response.id !== call.responseId || (response.service_tier && response.service_tier !== call.serviceTier)) {
        throw new Error('Параметры сохранённого ответа не совпадают с журналом; платные запросы остановлены.');
      }
      if (response.usage) {
        const web = webUsage(response);
        Object.assign(call, calculateUsageCost(response.usage, call.prices, web.webSearchCalls), web);
        call.status = 'settled';
        assertSettledCallWithinReservation(call);
      } else if (response.status === 'queued' || response.status === 'in_progress') call.status = 'pending';
      else quarantineMissingUsage(call, response);
      await save();
      if (call.quarantined) await event('API завершил запрос без данных о расходе. Полный резерв сохранён; остальные задания продолжаются в общем бюджете.', 'warning');
      break;
    }
  }
}

export async function runStructured<T>(kind: ApiCall['kind'], instructions: string, input: object,
  schema: z.ZodType<T>, onReserved: (id: string) => void, existingCallId?: string,
  shouldPause?: () => boolean, options?: { reasoningEffort: typeof config.reasoningEffort; maxOutputTokens: number }): Promise<{
    data: T; responseId: string; callId: string; model: string;
    sources: ReferenceSource[]; webSearchCalls: number; webToolCalls: number;
  }> {
  if (!config.apiEnabled) throw new Error('Paid API requests are disabled in this workspace');
  for (const recorded of state.calls) assertSettledCallWithinReservation(recorded);
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
    let submittedResponse: z.infer<typeof responseSchema> | undefined;
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
    if (call?.status === 'uncertain' && call.quarantined) throw new UnidentifiedApiOutcomeError(call.id);
    if (call?.status === 'uncertain' || (call && !call.responseId && !(call.status === 'settled' && call.terminalReason))) {
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
      const webSearchOverrun = state.calls.find(exceededWebSearchLimit);
      if (kind === 'research' && webSearchOverrun) {
        throw new RecoverableApiError(previous?.id ?? webSearchOverrun.id, 'web_search_disabled_after_overrun');
      }
      const previousLimit = previous?.maxOutputTokens ?? options?.maxOutputTokens ?? config.maxOutputTokens;
      const maxOutputTokens = previous?.terminalReason === 'max_output_tokens'
        ? Math.min(config.retryMaxOutputTokens, Math.max(previousLimit + 1, previousLimit * 2))
        : previousLimit;
      const prices = previous?.prices ?? {
        ...(kind === 'review' ? config.reviewPrices : config.prices),
        ...(kind === 'research' ? { webSearch: config.webSearchPricePerCall } : {}),
      };
      const webSearchMaxCalls = previous?.webSearchMaxCalls ?? config.webSearchMaxCalls;
      const reserved = estimateReservation(instructions, inputText, jsonSchema, kind, maxOutputTokens, prices, webSearchMaxCalls);
      const candidate: ApiCall = {
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
      call = await admitRequest(async () => {
        while (creationHealth === 'unverified' && activeCreations.size > 0) {
          if (shouldPause?.()) throw new RequestPausedError('Пауза запрошена до проверки доступности API.');
          await delay(100);
        }
        if (creationHealth === 'blocked') throw new Error(creationFailure ?? 'Создание запросов остановлено после ошибки API.');
        while (admissionAfter > Date.now()) {
          if (shouldPause?.()) throw new RequestPausedError('Пауза запрошена во время ожидания лимита API.');
          await delay(Math.min(1000, admissionAfter - Date.now()));
        }
        if (shouldPause?.()) throw new RequestPausedError('Пауза запрошена до следующего API-запроса.');
        for (const recorded of state.calls) {
          assertSettledCallWithinReservation(recorded);
          if (!Number.isFinite(recorded.cost) || recorded.cost < 0
            || !Number.isFinite(recorded.reserved) || recorded.reserved < 0) {
            throw new Error('Invalid API accounting data; paid requests are stopped');
          }
        }
        if (state.calls.some(item => (item.status === 'uncertain' && !item.quarantined)
          || (item.status === 'reserved' && !activeCreations.has(item.id)))) {
          throw new Error('Uncertain API accounting must be reconciled before any new paid request');
        }
        const overrun = state.calls.find(exceededWebSearchLimit);
        if (kind === 'research' && overrun) {
          throw new RecoverableApiError(previous?.id ?? overrun.id, 'web_search_disabled_after_overrun');
        }
        if (!Number.isFinite(state.budget.limit) || state.budget.limit <= 0
          || !Number.isFinite(reserved) || reserved <= 0) {
          throw new Error('Invalid API budget configuration; paid requests are stopped');
        }
        let waitingForBudget = false;
        for (;;) {
          if (shouldPause?.()) throw new RequestPausedError('Пауза запрошена во время ожидания свободного бюджета.');
          const usage = budgetUsage(state.calls, state.budget);
          const { spent, reserved: held } = usage;
          if (canReserve(usage, state.budget, reserved)) break;
          const inFlight = state.calls.some(item => item.status === 'pending'
            || (item.status === 'reserved' && activeCreations.has(item.id)));
          if (!inFlight) {
            const limit = state.budget.checkpoint
              ? Math.min(state.budget.limit, state.budget.checkpoint.reportedSpent + state.budget.checkpoint.additionalLimit)
              : state.budget.limit;
            throw new BudgetError(`Недостаточно свободного бюджета: потрачено $${spent.toFixed(2)}, резерв $${held.toFixed(2)}, следующий запрос до $${reserved.toFixed(2)}, лимит $${limit.toFixed(2)}.`);
          }
          if (!waitingForBudget) {
            waitingForBudget = true;
            await event('Ожидаю завершения оплачиваемых запросов и освобождения их резервов. Лимит бюджета сохранён.', 'info');
          }
          await delay(250);
        }
        activeCreations.add(candidate.id);
        state.calls.push(candidate);
        if (previous) previous.retryCallId = candidate.id;
        try {
          onReserved(candidate.id);
          await save();
          return candidate;
        } catch (error) {
          candidate.status = 'uncertain';
          candidate.quarantined = true;
          activeCreations.delete(candidate.id);
          throw error;
        }
      });
      try {
        const created = await request('/responses', {
          model: call.model, service_tier: call.serviceTier, instructions, input: inputText,
          reasoning: { effort: options?.reasoningEffort ?? (kind === 'review' ? config.reviewReasoningEffort
            : kind === 'research' ? config.researchReasoningEffort : config.generationReasoningEffort) },
          text: { format: { type: 'json_schema', name: kind, strict: true, schema: jsonSchema } },
          max_output_tokens: maxOutputTokens, background: call.serviceTier !== 'ultrafast',
          stream: call.serviceTier === 'ultrafast', store: true,
          ...(kind === 'research' ? {
            tools: [{ type: 'web_search', search_context_size: 'low' }],
            max_tool_calls: call.webSearchMaxCalls,
            include: ['web_search_call.action.sources'],
          } : {}),
        }, call.id, async id => {
          call!.responseId = id;
          call!.status = 'pending';
          await save();
        });
        creationHealth = 'ready';
        submittedResponse = created;
        call.responseId = created.id;
        call.status = 'pending';
        await save();
        if (previous) {
          await event(`${callLabel(kind)}: автоматическая попытка ${call.attempt}/${config.apiMaxAttempts}, причина: ${previous.terminalReason}. Лимит ответа: ${maxOutputTokens}.`);
        }
      } catch (error) {
        const message = (error instanceof Error ? error.message : 'Unknown API submission failure')
          .replaceAll(config.apiKey, '[redacted]').slice(0, 1500);
        call.submissionError = { message, ...(error instanceof HttpError ? {
          status: error.status, code: error.code, requestId: error.requestId,
        } : {}), ...(error instanceof Error && error.cause instanceof Error && 'code' in error.cause
          && typeof error.cause.code === 'string' ? { transportCode: error.cause.code } : {}) };
        if (!call.responseId && error instanceof HttpError
          && [400, 401, 403, 404, 405, 413, 415, 422].includes(error.status)) {
          call.status = 'settled';
          call.cost = 0;
          call.terminalReason = error.code ?? `http_${error.status}`;
          call.terminalRetryable = false;
          creationHealth = 'blocked';
          creationFailure = message;
          await save();
          throw new Error(message);
        }
        if (!call.responseId && error instanceof HttpError && error.status === 429) {
          admissionAfter = Math.max(admissionAfter, Date.now() + Math.max(config.recoveryBackoffMs, error.retryAfterMs ?? 0));
          call.status = 'settled';
          call.cost = 0;
          call.webSearchCalls = 0;
          call.webToolCalls = 0;
          call.toolSources = [];
          await terminalFailure(call, error.code ?? 'rate_limit_exceeded', error.code !== 'insufficient_quota');
          if (error.code === 'insufficient_quota') throw new BudgetError('API сообщил об исчерпании доступного баланса. Новые запросы остановлены.');
          await event('Достигнута скорость API. Новые запросы подождут автоматически; отклонённый запрос не оплачивается.', 'warning');
          continue;
        }
        call.status = call.responseId ? 'pending' : 'uncertain';
        if (!call.responseId) {
          call.quarantined = true;
          creationHealth = 'unverified';
          admissionAfter = Math.max(admissionAfter, Date.now() + Math.max(config.recoveryBackoffMs,
            error instanceof HttpError ? error.retryAfterMs ?? 0 : 0));
        }
        await save();
        if (!call.responseId) throw new UnidentifiedApiOutcomeError(call.id);
        throw new ResponsePollingError(config.recoveryBackoffMs);
      } finally {
        activeCreations.delete(call.id);
      }
    }
    let pollFailures = 0;
    let lastProgress = Date.now();
    let response: z.infer<typeof responseSchema>;
    for (;;) {
      try {
        const include = kind === 'research' ? '?include%5B%5D=web_search_call.action.sources' : '';
        response = submittedResponse ?? await request(`/responses/${encodeURIComponent(call.responseId!)}${include}`);
        submittedResponse = undefined;
        pollFailures = 0;
      } catch (error) {
        const transient = error instanceof HttpError
          ? error.status === 408 || error.status === 429 || error.status >= 500
          : error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
        pollFailures += 1;
        if (!transient) throw error;
        if (shouldPause?.()) throw new RequestPausedError('Получение ответа отложено до продолжения работы.');
        if (pollFailures >= 12 || (error instanceof HttpError && (error.retryAfterMs ?? 0) > 60000)) {
          throw new ResponsePollingError(Math.max(config.recoveryBackoffMs,
            error instanceof HttpError ? error.retryAfterMs ?? 0 : 0));
        }
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
    const webSearchWasDisabled = state.calls.some(exceededWebSearchLimit);
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
      quarantineMissingUsage(call, response);
    }
    await save();
    if (call.status !== 'settled') {
      throw new UnidentifiedApiOutcomeError(call.id);
    }
    assertSettledCallWithinReservation(call);
    if (!webSearchWasDisabled && exceededWebSearchLimit(call)) {
      await event('OpenAI превысил число поисков, но полная стоимость покрыта резервом. Веб-поиск автоматически отключён; сохраняю полученный ответ и продолжаю генерацию.', 'warning');
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
