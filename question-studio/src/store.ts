import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { StudioState } from './schema.js';

const stateFile = path.join(config.dataDir, 'state.json');
const lockFile = path.join(config.dataDir, 'studio.lock');
await mkdir(config.dataDir, { recursive: true });
try {
  const previous = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
  let alive = false;
  try { process.kill(previous.pid, 0); alive = true; } catch { /* A crashed worker leaves its lock for recovery. */ }
  if (alive) throw new Error('Question Studio is already running');
  await unlink(lockFile);
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const lock = await open(lockFile, 'wx');
await lock.writeFile(JSON.stringify({ pid: process.pid }));
await lock.close();
export async function releaseLock() { await unlink(lockFile).catch(() => undefined); }

function initialState(): StudioState {
  return {
    version: 1, runId: randomUUID(), status: 'idle', phase: 'Готово к запуску', error: null,
    model: config.model, budget: { limit: config.budget, spent: 0, reserved: 0 },
    config: { perTopic: config.perTopic, batchSize: config.batchSize, reasoningEffort: config.reasoningEffort,
      difficultyWeights: { easy: 0.25, medium: 0.45, hard: 0.30 } },
    topics: [], events: [], questions: [], calls: [], totals: { eligible: 0, generated: 0, published: 0, rejected: 0 },
    activeTopicId: null, mode: 'generate', sourceText: '', sourceOffset: 0, selectedTopicIds: [], pendingBatch: null,
    generationCallId: null,
  };
}
export const state: StudioState = await readFile(stateFile, 'utf8').then(value => {
  const saved = JSON.parse(value) as StudioState;
  if (saved.version !== 1 || !Array.isArray(saved.calls) || !Array.isArray(saved.questions)) throw new Error('Invalid studio state');
  const previousModel = saved.model;
  if (previousModel !== config.model && saved.calls.some(call => call.status !== 'settled')) {
    throw new Error('Finish or reconcile outstanding API calls before changing the model');
  }
  for (const call of saved.calls) {
    call.model ??= previousModel;
    if (!call.prices) {
      if (call.model === config.model) call.prices = { ...config.prices };
      else if (call.model === config.reviewModel) call.prices = { ...config.reviewPrices };
      else if (call.model === config.legacyPricing?.model) call.prices = { ...config.legacyPricing.prices };
      else throw new Error(`Missing price snapshot for ${call.model}; migrate with its original configuration or set OPENAI_LEGACY_MODEL and legacy prices`);
    }
    if (call.prices.cacheWrite === undefined) {
      if (call.model === config.model) call.prices.cacheWrite = config.prices.cacheWrite;
      else if (call.model === config.reviewModel) call.prices.cacheWrite = config.reviewPrices.cacheWrite;
      else if (call.model === config.legacyPricing?.model) call.prices.cacheWrite = config.legacyPricing.prices.cacheWrite;
      else throw new Error(`Missing cache-write price snapshot for ${call.model}; configure its legacy cache-write price`);
    }
    if (!call.model || !Number.isFinite(call.prices.input) || call.prices.input <= 0
      || !Number.isFinite(call.prices.cachedInput) || call.prices.cachedInput < 0
      || !Number.isFinite(call.prices.cacheWrite) || call.prices.cacheWrite <= 0
      || !Number.isFinite(call.prices.output) || call.prices.output <= 0
      || !Number.isFinite(call.cost) || call.cost < 0
      || !Number.isFinite(call.reserved) || call.reserved < 0) {
      throw new Error('Invalid persisted API accounting data');
    }
    if (call.kind === 'research' && (!Number.isFinite(call.prices.webSearch) || call.prices.webSearch! <= 0
      || !Number.isInteger(call.webSearchMaxCalls) || call.webSearchMaxCalls! < 1)) {
      throw new Error('Research request is missing its persisted tool pricing or call limit');
    }
  }
  for (const question of saved.questions) {
    if (!question.generation.reviewModel) {
      const reviewCall = saved.calls.find(call => call.kind === 'review'
        && call.responseId === question.generation.reviewResponseId);
      if (reviewCall) question.generation.reviewModel = reviewCall.model;
    }
  }
  saved.model = config.model;
  saved.config.reasoningEffort = config.reasoningEffort;
  saved.budget.limit = config.budget;
  if (saved.status === 'running') {
    saved.status = 'paused'; saved.phase = 'Работа прервана. Можно продолжить с сохранённого этапа.';
  }
  for (const call of saved.calls) if (call.status === 'reserved') call.status = 'uncertain';
  return saved;
}).catch(error => {
  if (error && 'code' in error && error.code === 'ENOENT') return initialState();
  throw error;
});

let writes = Promise.resolve();
export function save(): Promise<void> {
  state.budget.spent = state.calls.reduce((sum, call) => sum + call.cost, 0);
  state.budget.reserved = state.calls.filter(call => call.status !== 'settled').reduce((sum, call) => sum + call.reserved, 0);
  state.totals = {
    eligible: state.topics.filter(t => t.eligible).length,
    generated: state.questions.filter(q => q.validation.passed).length,
    published: state.questions.filter(q => q.status === 'published').length,
    rejected: state.questions.filter(q => !q.validation.passed).length,
  };
  for (const topic of state.topics) {
    topic.generated = state.questions.filter(q => q.topic === topic.id && q.validation.passed).length;
    if (!topic.targetPlanned) topic.target = topic.eligible ? state.config.perTopic : 0;
  }
  const data = JSON.stringify(state);
  const operation = writes.then(async () => {
    const temporary = `${stateFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, stateFile);
  });
  writes = operation.catch(() => undefined);
  return operation;
}
export async function event(message: string, level = 'info', topicId?: string) {
  state.events.push({ id: randomUUID(), time: Date.now(), level, message, ...(topicId ? { topicId } : {}) });
  if (state.events.length > 1500) state.events.splice(0, state.events.length - 1500);
  state.phase = message;
  await save();
}
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
  return message.replaceAll(config.apiKey, '[redacted]').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 700);
}
