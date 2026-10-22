import { z } from 'zod';
import { config } from './config.js';
import { budgetUsage, canReserve } from '../src/budget.js';
import { state, save, event } from './store.js';
import type { ApiCall, ModelPrices, ReferenceSource } from '../src/schema.js';
import { assertSettledCallWithinReservation, calculateUsageCost, exceededWebSearchLimit, restoreGeneratedQuestion, usageSchema } from '../src/schema.js';

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

export class CloudYieldError extends Error {}
export function sha256(value: string): string {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(byte => (byte & 255).toString(16).padStart(2, '0')).join('');
}
export class BudgetError extends Error {}
export class RequestPausedError extends Error {}
export class UnidentifiedApiOutcomeError extends Error {
  constructor(readonly callId: string) {
    super('Стоимость API-запроса не подтверждена. Полный резерв сохранён.');
  }
}
export class RecoverableApiError extends Error {
  constructor(readonly callId: string, readonly reason: string) {
    super(`Запрос ${callId}: ${reason}. Задание отложено после ограниченного числа попыток.`);
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(`OpenAI HTTP ${status}: ${message}`);
  }
}
export function sourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f]/.test(value)) return null;
  const parsed = /^https?:\/\/([^/?#]+)(?:[/?#].*)?$/.exec(value);
  return parsed && parsed[1] && !parsed[1].includes('@') ? value : null;
}
function sourceHost(value: string): string {
  return /^https?:\/\/([^/?#]+)/.exec(value)?.[1] || value;
}

function webUsage(response: z.infer<typeof responseSchema>) {
  const calls = (response.output || []).filter(output => output.type === 'web_search_call');
  const sources = new Map<string, ReferenceSource>();
  for (const call of calls) {
    if (call.status !== 'completed') continue;
    for (const source of call.action?.sources || []) {
      const url = source.type === 'url' ? sourceUrl(source.url) : null;
      if (url) sources.set(url, { url, title: source.title?.trim().slice(0, 300) || sourceHost(url) });
    }
    const opened = call.action?.type === 'open_page' ? sourceUrl(call.action.url) : null;
    if (opened && !sources.has(opened)) sources.set(opened, { url: opened, title: sourceHost(opened) });
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
  if ((kind !== 'generation' && kind !== 'repair') || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  const normalizeQuestion = (question: unknown): unknown => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) return question;
    const record = question as Record<string, unknown>;
    const diagram = record.diagram && typeof record.diagram === 'object' && !Array.isArray(record.diagram)
      ? record.diagram as Record<string, unknown> : undefined;
    const normalized = diagram ? { ...record, diagram: {
      ...diagram,
      ...(!Object.prototype.hasOwnProperty.call(diagram, 'arcs') ? { arcs: [] } : {}),
      ...(!Object.prototype.hasOwnProperty.call(diagram, 'angles') ? { angles: [] } : {}),
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
  const inputBound = Utilities.newBlob(instructions + input + JSON.stringify(schema)).getBytes().length + 4096;
  if (inputBound > 200000) throw new Error('Input is too large for the configured pricing tier');
  const reservedInput = kind === 'research' ? Math.max(inputBound, config.webSearchInputTokenReserve) : inputBound;
  const toolFee = kind === 'research' ? webSearchMaxCalls * (prices.webSearch ?? config.webSearchPricePerCall) : 0;
  const maximumInputPrice = Math.max(prices.input, prices.cachedInput, prices.cacheWrite);
  return (reservedInput * maximumInputPrice + maxOutputTokens * prices.output) / 1000000 + toolFee;
}

function request(endpoint: string, body?: object) {
  const response = UrlFetchApp.fetch(`${config.apiBase}${endpoint}`, {
    method: body ? 'post' : 'get',
    headers: { Authorization: `Bearer ${config.apiKey}`,
      ...(body && 'service_tier' in body && body.service_tier === 'ultrafast' ? { 'OpenAI-Service-Tier': 'ultrafast' } : {}) },
    contentType: 'application/json', muteHttpExceptions: true,
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
  const status = response.getResponseCode();
  let data: unknown;
  try { data = JSON.parse(response.getContentText()); }
  catch { if (status >= 200 && status < 300) throw new Error('OpenAI returned malformed JSON'); }
  if (status < 200 || status >= 300) {
    const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(data);
    throw new HttpError(status, parsed.success ? parsed.data.error.message : 'Request failed');
  }
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

function terminalFailure(call: ApiCall, reason: string, retryable: boolean) {
  call.terminalReason = reason;
  call.terminalRetryable = retryable;
  event(`${callLabel(call.kind)}: ответ не принят (${reason}); учтено $${call.cost.toFixed(4)}.`, 'warning');
  throw new CloudYieldError('Результат учтён; следующая попытка выполняется отдельным запуском.');
}

export function runStructured<T>(kind: ApiCall['kind'], instructions: string, input: object,
  schema: z.ZodType<T>, onReserved: (id: string) => void, existingCallId?: string,
  shouldPause?: () => boolean): {
    data: T; responseId: string; callId: string; model: string;
    sources: ReferenceSource[]; webSearchCalls: number; webToolCalls: number;
  } {
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
      save();
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
      terminalFailure(call, 'invalid_structured_result', true);
    }
    if (call?.status === 'uncertain' && call.quarantined) throw new UnidentifiedApiOutcomeError(call.id);
    if (call && !call.responseId) {
      throw new Error('Неопределённый результат API-запроса. Резерв сохранён; повторная оплата автоматически запрещена.');
    }
    const previous = call?.terminalReason ? call : undefined;
    if (previous && (previous.status !== 'settled' || !previous.terminalRetryable
      || attemptNumber(previous) >= config.apiMaxAttempts)) {
      if (previous.status !== 'settled') throw new Error('Unsettled API response cannot be retried');
      throw new RecoverableApiError(previous.id, previous.terminalReason!);
    }
    if (!call || previous) {
      if (state.calls.some(item => (item.status === 'uncertain' && !item.quarantined) || item.status === 'reserved')) {
        throw new Error('Uncertain API accounting must be reconciled before any new paid request');
      }
      if (shouldPause?.()) throw new RequestPausedError('Пауза запрошена до следующего API-запроса.');
      if (kind === 'research' && !config.webSearchEnabled) throw new Error('Web research is disabled');
      const webSearchOverrun = state.calls.find(exceededWebSearchLimit);
      if (kind === 'research' && webSearchOverrun) {
        throw new RecoverableApiError(previous?.id ?? webSearchOverrun.id, 'web_search_disabled_after_overrun');
      }
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
      if (!canReserve(budgetUsage(state.calls, state.budget), state.budget, reserved)) {
        throw new BudgetError('Оставшегося бюджета недостаточно для безопасного резерва следующего запроса.');
      }
      call = {
        id: Utilities.getUuid(), kind, model: previous?.model ?? (kind === 'review' ? config.reviewModel : config.model),
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
      save();
      if (previous) {
        event(`${callLabel(kind)}: автоматическая попытка ${call.attempt}/${config.apiMaxAttempts}, причина: ${previous.terminalReason}. Лимит ответа: ${maxOutputTokens}.`);
      }
      try {
        const created = request('/responses', {
          model: call.model, service_tier: call.serviceTier, instructions, input: inputText,
          reasoning: { effort: kind === 'review' ? config.reviewReasoningEffort
            : kind === 'research' ? config.researchReasoningEffort : config.generationReasoningEffort },
          text: { format: { type: 'json_schema', name: kind, strict: true, schema: jsonSchema } },
          max_output_tokens: maxOutputTokens, background: call.serviceTier !== 'ultrafast', store: true,
          ...(kind === 'research' ? {
            tools: [{ type: 'web_search', search_context_size: 'low' }],
            max_tool_calls: call.webSearchMaxCalls,
            include: ['web_search_call.action.sources'],
          } : {}),
        });
        call.responseId = created.id;
        call.status = 'pending';
        save();
      } catch (error) {
        call.status = 'uncertain';
        save();
        throw error;
      }
      throw new CloudYieldError('Запрос сохранён; ответ будет получен следующим запуском.');
    }
    let response: z.infer<typeof responseSchema>;
    try {
      const include = kind === 'research' ? '?include%5B%5D=web_search_call.action.sources' : '';
      response = request(`/responses/${encodeURIComponent(call.responseId!)}${include}`);
    } catch (error) {
      if (error instanceof HttpError && error.status !== 408 && error.status !== 429 && error.status < 500) throw error;
      if (error instanceof z.ZodError) throw error;
      throw new CloudYieldError('Получение сохранённого ответа будет повторено следующим облачным запуском.');
    }
    if (response.status === 'queued' || response.status === 'in_progress') {
      throw new CloudYieldError('Ответ OpenAI ещё готовится.');
    }
    if (response.id !== call.responseId) throw new Error('OpenAI returned a different response ID; its charge must be reconciled');
    if (call.serviceTier && response.service_tier && response.service_tier !== call.serviceTier) {
      call.status = 'uncertain';
      save();
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
        save();
        throw error;
      }
      call.status = 'settled';
    } else if (call.status !== 'settled') {
      call.status = 'uncertain';
      if (['failed', 'cancelled', 'incomplete'].includes(response.status)) {
        call.quarantined = true;
        call.terminalReason = `usage_unavailable:${response.status}:${response.error?.code ?? response.incomplete_details?.reason ?? 'unknown'}`;
        call.terminalRetryable = false;
      }
    }
    save();
    if (call.status !== 'settled') {
      if (call.quarantined) throw new UnidentifiedApiOutcomeError(call.id);
      throw new Error('OpenAI returned no usage; the reservation is retained until accounting can be reconciled');
    }
    assertSettledCallWithinReservation(call);
    if (!webSearchWasDisabled && exceededWebSearchLimit(call)) {
      event('OpenAI превысил число поисков, но полная стоимость покрыта резервом. Веб-поиск автоматически отключён; сохраняю полученный ответ и продолжаю генерацию.', 'warning');
    }
    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason || 'incomplete_response';
      terminalFailure(call, reason, reason === 'max_output_tokens');
      continue;
    }
    if (response.status === 'failed' || response.status === 'cancelled') {
      const reason = response.error?.code || response.status;
      terminalFailure(call, reason, ['server_error', 'rate_limit_exceeded', 'vector_store_timeout'].includes(reason));
      continue;
    }
    if (response.status !== 'completed') throw new Error(`OpenAI returned unknown response status: ${response.status}`);
    const content = response.output?.flatMap(output => output.content || []) ?? [];
    if (content.some(item => item.type === 'refusal')) {
      terminalFailure(call, 'refusal', false);
      continue;
    }
    const text = content.filter(item => item.type === 'output_text').map(item => item.text || '').join('');
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch {
      terminalFailure(call, 'invalid_json', true);
      continue;
    }
    const validated = schema.safeParse(normalizeGenerationResult(kind, parsed));
    if (!validated.success) {
      terminalFailure(call, 'invalid_structured_result', true);
      continue;
    }
    call.result = validated.data;
    save();
    event(`${callLabel(kind)}: ${call.outputTokens || 0} выходных токенов, $${call.cost.toFixed(4)}.`);
    return {
      data: validated.data, responseId: response.id, callId: call.id, model: call.model,
      sources: call.toolSources, webSearchCalls: call.webSearchCalls, webToolCalls: call.webToolCalls,
    };
  }
}
