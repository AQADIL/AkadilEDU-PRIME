import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config.js';
import { state, save, event, safeError } from './store.js';
import { difficulties, type Difficulty, type GenerationJob, type StoredQuestion, type Topic } from './schema.js';
import { BudgetError, RecoverableApiError, RequestPausedError, ResponsePollingError, UnidentifiedApiOutcomeError } from './provider.js';
import { BatchContentError, questionFingerprint } from './assessment.js';
import { nextRepair, repairQuestion } from './repair.js';
import { RenderRetryError } from './render.js';
import { checkTopicCompletion } from './topicCompletion.js';

interface PipelineHandlers {
  generate(topic: Topic, job: GenerationJob, shouldPause: () => boolean): Promise<void>;
  review(job: GenerationJob, shouldPause: () => boolean): Promise<void>;
}
interface TaskResult {
  id: string;
  job?: GenerationJob;
  question?: StoredQuestion;
  error?: unknown;
}
interface ActiveTask {
  topicId: string;
  result: Promise<TaskResult>;
}

function planDifficulty(count: number, topicId: string): Difficulty[] {
  const counts = Object.fromEntries(difficulties.map(difficulty => [difficulty,
    state.questions.filter(question => question.topic === topicId && question.validation.passed && question.difficulty === difficulty).length
    + (state.jobs ?? []).filter(job => job.topicId === topicId).reduce((sum, job) => sum + job.difficultyPlan.filter(value => value === difficulty).length, 0),
  ])) as Record<Difficulty, number>;
  return Array.from({ length: count }, () => {
    const next = [...difficulties].sort((a, b) => counts[a] / state.config.difficultyWeights[a]
      - counts[b] / state.config.difficultyWeights[b]
      || state.config.difficultyWeights[b] - state.config.difficultyWeights[a])[0]!;
    counts[next]++;
    return next;
  });
}

function recoverUnidentifiedCall(callId: string): boolean {
  const call = state.calls.find(item => item.id === callId);
  if (!call || call.status !== 'uncertain'
    || (call.responseId && !(call.quarantined && call.terminalReason?.startsWith('usage_unavailable:')))) return false;
  let changed = !call.quarantined;
  call.quarantined = true;
  for (const job of state.jobs ?? []) {
    if (job.generationCallId === call.id) { delete job.generationCallId; changed = true; }
    if (job.batch?.reviewCallId === call.id) { delete job.batch.reviewCallId; changed = true; }
  }
  for (const question of state.questions) {
    if (question.repair?.generationCallId === call.id) { delete question.repair.generationCallId; changed = true; }
    if (question.repair?.reviewCallId === call.id) {
      delete question.repair.reviewCallId;
      delete question.repair.originalReviewRequired;
      changed = true;
    }
  }
  if (call.kind === 'research') {
    const topic = state.topics.find(item => item.researchCallId === call.id);
    if (topic && !topic.researchUnavailable) { topic.researchUnavailable = true; changed = true; }
  }
  for (const topic of state.topics) {
    if (topic.progress?.audit?.callId === call.id) { delete topic.progress.audit; changed = true; }
  }
  return changed;
}

async function migrateSerialWork() {
  state.jobs ??= [];
  if (state.pendingBatch || state.generationCallId) {
    const topic = state.topics.find(item => item.id === state.activeTopicId && item.eligible);
    if (!topic || state.jobs.some(job => job.topicId === topic.id)) throw new Error('Невозможно однозначно восстановить сохранённую партию');
    const count = state.pendingBatch?.questions.length || Math.min(state.config.batchSize, topic.target - topic.generated);
    state.jobs.push({
      id: randomUUID(), topicId: topic.id, count,
      difficultyPlan: state.pendingBatch?.questions.map(question => question.difficulty) ?? planDifficulty(count, topic.id),
      stage: state.pendingBatch ? 'review' : 'generation',
      ...(state.pendingBatch ? { batch: state.pendingBatch } : {}),
      ...(state.generationCallId ? { generationCallId: state.generationCallId } : {}),
    });
    state.pendingBatch = null;
    state.generationCallId = null;
  }
  for (const call of state.calls) recoverUnidentifiedCall(call.id);
  await save();
}

function availableTopic(topic: Topic): boolean {
  return topic.eligible
    && (!state.selectedTopicIds.length || state.selectedTopicIds.includes(topic.id))
    && (topic.failedBatches ?? 0) < config.maxTopicFailures && (topic.requestFailures ?? 0) < config.maxTopicFailures
    && topic.progress?.status !== 'completed' && topic.progress?.status !== 'blocked';
}

async function archiveFailedJob(job: GenerationJob, error: unknown) {
  const topic = state.topics.find(item => item.id === job.topicId);
  if (topic) topic.requestFailures = (topic.requestFailures ?? 0) + 1;
  if (job.batch) {
    const batch = job.batch;
    const generation = state.calls.find(call => call.id === batch.generationCallId);
    if (!generation?.responseId) throw new Error('У сохранённой партии отсутствует ID ответа');
    const review = state.calls.find(call => call.id === batch.reviewCallId);
    for (const [index, generated] of batch.questions.entries()) {
      const id = createHash('sha256').update(`${state.runId}:${generation.responseId}:${index}`).digest('hex').slice(0, 40);
      if (state.questions.some(question => question.id === id)) continue;
      state.questions.push({ id, topic: generated.primaryTopicId, difficulty: generated.difficulty,
        correctOption: generated.correctOption, translations: generated.translations, diagram: generated.diagram,
        fingerprint: questionFingerprint(generated), status: 'rejected',
        validation: { passed: false, issues: [`Проверка не завершена: ${safeError(error)}`] },
        generation: { model: generation.model, responseId: generation.responseId,
          reviewModel: review?.model, reviewResponseId: review?.responseId ?? '', runId: state.runId, createdAt: Date.now(),
          ...(generation.researchResponseId ? { researchResponseId: generation.researchResponseId,
            referenceSources: generation.referenceSources ?? [] } : {}) } });
    }
  }
  state.jobs = state.jobs!.filter(item => item.id !== job.id);
  await event(`Партия отложена после лимита попыток: ${safeError(error)}. Остальные потоки продолжают работу.`, 'warning', job.topicId);
}

export async function runParallelPipeline(handlers: PipelineHandlers, pauseRequested: () => boolean) {
  const active = new Map<string, ActiveTask>();
  let halted = false;
  let failure: unknown;
  let budgetBlocked = false;
  const shouldPause = () => pauseRequested() || halted;
  state.status = 'running';
  state.error = null;
  try {
    await migrateSerialWork();
    await event(`Последовательно завершаю темы. До ${config.concurrency} параллельных задач внутри текущей темы; проверка сохранена.`, 'info');
    const launch = (id: string, topicId: string, operation: () => Promise<void>, job?: GenerationJob, question?: StoredQuestion) => {
      const result = operation().then((): TaskResult => ({ id, job, question }), (error: unknown): TaskResult => {
        if (!(error instanceof RequestPausedError || error instanceof UnidentifiedApiOutcomeError
          || error instanceof ResponsePollingError || error instanceof RenderRetryError || error instanceof RecoverableApiError || error instanceof BatchContentError)) {
          halted = true;
          failure ??= error;
          budgetBlocked ||= error instanceof BudgetError;
        }
        return { id, job, question, error };
      });
      active.set(id, { topicId, result });
    };
    while (!shouldPause() || active.size) {
      let topic = state.topics.find(item => item.id === state.activeTopicId && availableTopic(item));
      if (!topic && !active.size && !shouldPause()) {
        topic = state.topics.find(availableTopic);
        state.activeTopicId = topic?.id ?? null;
        if (topic) {
          topic.progress ??= { status: 'working' };
          await event(`Текущая тема: ${topic.path.join(' / ')}. Завершаю её перед переходом к следующей.`, 'info', topic.id);
        }
      }
      const excludedTopics = new Set(state.topics.filter(item => item.id !== topic?.id).map(item => item.id));
      if (topic && !active.size && !shouldPause() && topic.generated >= config.minTopicQuestions
        && !topic.progress?.curriculumRole && !state.jobs!.some(job => job.topicId === topic.id)) {
        topic.target = topic.generated;
        await save();
      }
      while (!shouldPause() && active.size < config.concurrency) {
        if (!topic) break;
        const queued = state.jobs!.find(job => job.topicId === topic.id && !active.has(job.id) && (job.retryAt ?? 0) <= Date.now());
        if (queued) {
          delete queued.retryAt;
          launch(queued.id, queued.topicId, async () => {
            const topic = state.topics.find(item => item.id === queued.topicId && item.eligible);
            if (!topic) throw new Error('Тема сохранённой партии недоступна');
            if (!queued.batch) await handlers.generate(topic, queued, shouldPause);
            if (shouldPause()) return;
            if (!queued.batch) throw new Error('Генерация не сохранила партию');
            await handlers.review(queued, shouldPause);
            state.jobs = state.jobs!.filter(item => item.id !== queued.id);
            await save();
          }, queued);
          continue;
        }
        const activeRepairs = [...active.keys()].filter(id => id.startsWith('repair:')).length;
        const activeRepairIds = new Set([...active.keys()].filter(id => id.startsWith('repair:')).map(id => id.slice('repair:'.length)));
        const repair = topic.generated < topic.target && activeRepairs < config.repairConcurrency
          ? nextRepair(excludedTopics, Date.now(), activeRepairIds) : undefined;
        if (repair) {
          launch(`repair:${repair.id}`, repair.topic, () => repairQuestion(repair, shouldPause), undefined, repair);
          continue;
        }
        if (topic.generated >= topic.target || state.jobs!.some(job => job.topicId === topic.id)) break;
        const count = Math.min(state.config.batchSize, topic.target - topic.generated);
        const job: GenerationJob = { id: randomUUID(), topicId: topic.id, count,
          difficultyPlan: planDifficulty(count, topic.id), stage: 'generation' };
        state.jobs!.push(job);
        await save();
      }
      if (!active.size) {
        if (shouldPause()) break;
        const topicJobs = state.jobs!.filter(job => job.topicId === topic?.id);
        const waitingRepair = topic && topic.generated < topic.target ? nextRepair(excludedTopics, Number.POSITIVE_INFINITY) : undefined;
        if (topicJobs.length || waitingRepair) {
          const next = Math.min(...topicJobs.map(job => job.retryAt ?? Date.now()), waitingRepair?.repair?.retryAt ?? Number.POSITIVE_INFINITY);
          await delay(Math.max(1, Math.min(1000, next - Date.now())));
          continue;
        }
        if (topic) {
          try { await checkTopicCompletion(topic, shouldPause); }
          catch (error) {
            if (error instanceof BudgetError) throw error;
            if (error instanceof RequestPausedError) break;
            if (error instanceof UnidentifiedApiOutcomeError) recoverUnidentifiedCall(error.callId);
            if (!(error instanceof UnidentifiedApiOutcomeError || error instanceof ResponsePollingError)) {
              topic.requestFailures = (topic.requestFailures ?? 0) + 1;
              if (error instanceof RecoverableApiError && topic.progress) delete topic.progress.audit;
            }
            await event(`${topic.name}: проверка покрытия отложена — ${safeError(error)}. Сохранённый результат не оплачивается повторно.`, 'warning', topic.id);
            await delay(Math.min(config.recoveryBackoffMs, 10000));
          }
          continue;
        }
        const deferred = state.topics.filter(topic => topic.eligible
          && (!state.selectedTopicIds.length || state.selectedTopicIds.includes(topic.id))
          && (topic.progress?.status === 'blocked' || (topic.failedBatches ?? 0) >= config.maxTopicFailures || (topic.requestFailures ?? 0) >= config.maxTopicFailures));
        state.status = deferred.length ? 'paused' : 'completed';
        await event(deferred.length ? `Отложено тем после лимита попыток: ${deferred.length}.`
          : 'План выполнен. Все принятые задания сохранены в Firebase.', deferred.length ? 'warning' : 'success');
        return;
      }
      const result = await Promise.race([...active.values()].map(task => task.result));
      active.delete(result.id);
      if (!result.error || result.error instanceof RequestPausedError) continue;
      if (result.error instanceof UnidentifiedApiOutcomeError || result.error instanceof ResponsePollingError || result.error instanceof RenderRetryError) {
        const error = result.error;
        if (error instanceof UnidentifiedApiOutcomeError) recoverUnidentifiedCall(error.callId);
        if (result.job) {
          result.job.stage = 'waiting';
          result.job.retryAt = Date.now() + (error instanceof ResponsePollingError || error instanceof RenderRetryError ? error.retryAfterMs : config.recoveryBackoffMs);
        }
        if (result.question) {
          if (!result.question.repair) throw new Error('У исправления отсутствует сохранённый этап');
          result.question.repair.retryAt = Date.now() + (error instanceof ResponsePollingError || error instanceof RenderRetryError ? error.retryAfterMs : config.recoveryBackoffMs);
        }
        await event(error instanceof RenderRetryError ? error.message : error instanceof UnidentifiedApiOutcomeError
          ? 'Ответ не подтверждён. Весь резерв сохранён; партия продолжится после паузы новым запросом.'
          : 'Ожидаю восстановления связи для сохранённого ответа. Повторная отправка не требуется.', 'warning', result.job?.topicId ?? result.question?.topic);
        continue;
      }
      if (result.job && (result.error instanceof RecoverableApiError || result.error instanceof BatchContentError)) {
        await archiveFailedJob(result.job, result.error);
      }
    }
    state.status = failure ? budgetBlocked ? 'budget_exhausted' : 'error' : 'paused';
    state.error = failure ? safeError(failure) : null;
    await event(state.error ?? 'Все потоки остановлены. Партии и расходы сохранены.', failure ? 'error' : 'info');
  } catch (error) {
    halted = true;
    await Promise.allSettled([...active.values()].map(task => task.result));
    state.status = error instanceof BudgetError ? 'budget_exhausted' : 'error';
    state.error = safeError(error);
    await event(state.error, 'error');
  } finally {
    await save();
  }
}
