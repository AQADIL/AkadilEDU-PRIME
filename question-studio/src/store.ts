import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { StudioState } from './schema.js';
import { generationJobSchema } from './schema.js';
import { budgetCheckpointSchema, budgetHistorySchema, budgetUsage } from './budget.js';
import { StatePersistence } from './statePersistence.js';

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
const persistence = new StatePersistence(path.join(config.dataDir, 'state.sqlite'), config.stateWriteTimeoutMs);
export async function releaseLock() { persistence.close(); await unlink(lockFile).catch(() => undefined); }

function initialState(): StudioState {
  return {
    version: 1, runId: randomUUID(), status: 'idle', phase: 'Готово к запуску', error: null,
    model: config.model, budget: { limit: config.budget, spent: 0, reserved: 0 },
    config: { perTopic: config.perTopic, batchSize: config.batchSize, reasoningEffort: config.reasoningEffort,
      topicLimits: { minimum: config.minTopicQuestions, maximum: config.maxTopicQuestions },
      difficultyWeights: { easy: 0.25, medium: 0.45, hard: 0.30 } },
    topics: [], events: [], questions: [], calls: [], totals: { eligible: 0, generated: 0, published: 0, rejected: 0 },
    activeTopicId: null, mode: 'generate', sourceText: '', sourceOffset: 0, selectedTopicIds: [], pendingBatch: null,
    generationCallId: null,
    jobs: [],
  };
}
async function loadState(): Promise<StudioState> {
  const stored = persistence.load();
  if (stored) return stored;
  try { return JSON.parse(await readFile(stateFile, 'utf8')) as StudioState; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return initialState();
    throw error;
  }
}
export const state: StudioState = await loadState().then(saved => {
  if (saved.version !== 1 || !Array.isArray(saved.calls) || !Array.isArray(saved.questions)) throw new Error('Invalid studio state');
  saved.jobs = generationJobSchema.array().parse(saved.jobs ?? []);
  if (new Set(saved.jobs.map(job => job.id)).size !== saved.jobs.length) throw new Error('Duplicate generation jobs');
  for (const job of saved.jobs) {
    if (!saved.topics.some(topic => topic.id === job.topicId && topic.eligible)) throw new Error('Generation job has an invalid topic');
    for (const [id, kind] of [[job.generationCallId, 'generation'], [job.batch?.generationCallId, 'generation'],
      [job.batch?.reviewCallId, 'review']] as const) {
      if (id && !saved.calls.some(call => call.id === id && call.kind === kind)) throw new Error('Generation job has an invalid request reference');
    }
  }
  const previousModel = saved.model;
  if (previousModel !== config.model && saved.calls.some(call => call.status !== 'settled' && !call.quarantined)) {
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
    if (call.quarantined && (call.status !== 'uncertain'
      || (call.responseId && !call.terminalReason?.startsWith('usage_unavailable:')))) {
      throw new Error('Invalid quarantined API request');
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
  saved.config.batchSize = config.batchSize;
  saved.config.perTopic = config.perTopic;
  saved.config.topicLimits = { minimum: config.minTopicQuestions, maximum: config.maxTopicQuestions };
  for (const topic of saved.topics) topic.target = topic.eligible
    ? Math.max(topic.generated, Math.min(topic.progress?.curriculumRole ? config.maxTopicQuestions : config.perTopic, topic.target)) : 0;
  saved.budget.limit = config.budget;
  if (saved.budget.checkpoint) saved.budget.checkpoint = budgetCheckpointSchema.parse(saved.budget.checkpoint);
  if (saved.budget.history) saved.budget.history = budgetHistorySchema.parse(saved.budget.history);
  const usage = budgetUsage(saved.calls, saved.budget);
  saved.budget.spent = usage.spent;
  saved.budget.reserved = usage.reserved;
  if (saved.status === 'running') {
    saved.status = 'paused'; saved.phase = 'Работа прервана. Можно продолжить с сохранённого этапа.';
  }
  for (const call of saved.calls) if (call.status === 'reserved') call.status = 'uncertain';
  return saved;
});

let writes = Promise.resolve();
let requestedRevision = 0;
let persistedRevision = 0;
export function stateRevision(): number { return requestedRevision; }
export function save(): Promise<void> {
  const usage = budgetUsage(state.calls, state.budget);
  state.budget.spent = usage.spent;
  state.budget.reserved = usage.reserved;
  const countsByTopic = new Map<string, number>();
  const validQuestionIds = new Set<string>();
  let generated = 0;
  let published = 0;
  for (const question of state.questions) {
    if (question.validation.passed) {
      validQuestionIds.add(question.id);
      generated++;
      countsByTopic.set(question.topic, (countsByTopic.get(question.topic) ?? 0) + 1);
    }
    if (question.status === 'published') published++;
  }
  state.totals = {
    eligible: state.topics.filter(t => t.eligible).length,
    generated,
    published,
    rejected: state.questions.length - generated,
  };
  for (const topic of state.topics) {
    topic.generated = countsByTopic.get(topic.id) ?? 0;
    if (topic.progress?.status === 'completed' && topic.progress.checkedQuestionIds?.some(id =>
      !validQuestionIds.has(id))) {
      topic.progress.status = 'needs_work';
      delete topic.progress.completedAt;
    }
    if (!topic.targetPlanned) topic.target = topic.eligible ? state.config.perTopic : 0;
  }
  const revision = ++requestedRevision;
  const operation = writes.then(async () => {
    if (persistedRevision >= revision) return;
    const snapshotRevision = requestedRevision;
    persistence.save(state);
    persistedRevision = snapshotRevision;
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
