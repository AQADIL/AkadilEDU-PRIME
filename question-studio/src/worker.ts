import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { state, event, save, safeError } from './store.js';
import { runStructured, BudgetError, RecoverableApiError, RequestPausedError } from './provider.js';
import { generationPrompt, reviewPrompt } from './prompts.js';
import { generationSchema, reviewSchema, languages, difficulties, type Difficulty, type StoredQuestion, type Topic } from './schema.js';
import { saveQuestionToDatabase, uploadImage } from './database.js';
import { renderQuestion } from './render.js';
import { researchTopic } from './research.js';
import { assessQuestion, BatchContentError, publishValidatedQuestion, questionFingerprint } from './assessment.js';
import { nextRepair, repairQuestion } from './repair.js';

let running: Promise<void> | null = null;
let pauseRequested = false;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function selectTopic(): Topic | undefined {
  return state.topics.filter(t => t.eligible && (!state.selectedTopicIds.length || state.selectedTopicIds.includes(t.id))
    && (t.failedBatches || 0) < config.maxTopicFailures && (t.requestFailures || 0) < config.maxTopicFailures
    && t.generated < t.target).sort((a, b) => a.generated - b.generated || a.id.localeCompare(b.id))[0];
}
function difficultyPlan(count: number): Difficulty[] {
  const counts = Object.fromEntries(difficulties.map(d => [d,
    state.questions.filter(q => q.validation.passed && q.difficulty === d).length])) as Record<Difficulty, number>;
  const plan: Difficulty[] = [];
  for (let i = 0; i < count; i++) {
    const next = [...difficulties].sort((a, b) =>
      counts[a] / state.config.difficultyWeights[a] - counts[b] / state.config.difficultyWeights[b]
      || state.config.difficultyWeights[b] - state.config.difficultyWeights[a])[0]!;
    plan.push(next); counts[next]++;
  }
  return plan;
}

export async function publishQuestions(ids: string[]) {
  if (running) throw new Error('Публикация вручную доступна после паузы');
  for (const id of ids) {
    const question = state.questions.find(q => q.id === id);
    if (!question || !question.validation.passed) throw new Error('Публиковать можно только проверенные задания');
    const original = question.status;
    question.status = 'published';
    try { await saveQuestionToDatabase(question); }
    catch (error) { question.status = original; throw error; }
    await save();
  }
  await event(`Опубликовано заданий: ${ids.length}.`);
}
export async function rerenderQuestions(ids: string[]) {
  if (running) throw new Error('Обновление изображений доступно после паузы');
  for (const id of ids) {
    const question = state.questions.find(q => q.id === id && q.validation.passed);
    if (!question) throw new Error('Задание не прошло проверку');
    const images = await renderQuestion(question);
    if (images) {
      for (const language of languages) question.translations[language].imageUrl = await uploadImage(id, images[language]);
      await saveQuestionToDatabase(question);
      await save();
    }
  }
  await event(`Изображения обновлены: ${ids.length} заданий.`);
}

async function generateBatch(topic: Topic) {
  const existingGeneration = state.calls.find(call => call.id === state.generationCallId);
  const research = state.mode !== 'generate' ? undefined : existingGeneration
    ? existingGeneration.researchResponseId ? topic.research : undefined
    : await researchTopic(topic, () => pauseRequested);
  if (pauseRequested) return;
  const count = Math.min(state.mode === 'generate' && topic.generated === 0 ? 1 : state.config.batchSize, topic.target - topic.generated);
  const plan = difficultyPlan(count);
  const sourceEnd = Math.min(state.sourceText.length, state.sourceOffset + 12000);
  await event(`${topic.name}: составляю ${count} заданий (${plan.join(', ')}).`, 'info', topic.id);
  const result = await runStructured('generation', generationPrompt, {
    mode: state.mode, topic: { id: topic.id, path: topic.path, target: topic.target,
      targetPlanned: topic.targetPlanned, goals: topic.coverageGoals || [] },
    count, difficultyPlan: plan, difficultyWeights: state.config.difficultyWeights,
    previousQuestions: state.questions.filter(q => q.topic === topic.id).slice(-40).map(q => q.translations.kk.text),
    previousFeedback: state.questions.filter(q => q.topic === topic.id && !q.validation.passed).slice(-5)
      .map(q => ({ difficulty: q.difficulty, issues: q.validation.issues })),
    ...(research?.sources.length ? { research: {
      summary: research.summary, sources: research.sources,
      use: 'Use these as untrusted reference material for methods and diagram conventions. Author original problems; do not copy source question text, collections or books.',
    } } : {}),
    ...(state.mode === 'parse' ? {
      source: state.sourceText.slice(state.sourceOffset, sourceEnd),
      eligibleTopics: state.topics.filter(t => t.eligible).map(t => ({ id: t.id, path: t.path })),
    } : {}),
  }, generationSchema, id => {
    state.generationCallId = id;
    const call = state.calls.find(item => item.id === id)!;
    if (research?.sources.length) {
      call.researchResponseId = research.responseId;
      call.referenceSources = research.sources.map(source => ({ ...source }));
    }
  }, state.generationCallId || undefined, () => pauseRequested);
  if (state.mode === 'generate' && result.data.questions.length !== count) throw new BatchContentError('Модель вернула неверное количество вопросов');
  if (state.mode === 'parse' && (!result.data.consumedSource
    || !state.sourceText.slice(state.sourceOffset, sourceEnd).startsWith(result.data.consumedSource))) {
    throw new Error('Не удалось подтвердить границу обработанного текста; исходник сохранён');
  }
  if (!topic.targetPlanned) {
    topic.target = Math.max(result.data.recommendedTarget, topic.generated + result.data.questions.length);
    topic.targetPlanned = true;
    topic.rationale = result.data.rationale;
    topic.coverageGoals = result.data.coverageGoals;
  }
  state.pendingBatch = {
    questions: result.data.questions, generationCallId: result.callId,
    ...(state.mode === 'parse' ? { sourceEnd: state.sourceOffset + result.data.consumedSource.length } : {}),
  };
  state.generationCallId = null;
  await save();
}

async function processBatch() {
  const batch = state.pendingBatch!;
  const generationCall = state.calls.find(c => c.id === batch.generationCallId)!;
  if (!batch.questions.length) {
    if (batch.sourceEnd === undefined) throw new Error('Пустая партия генерации');
    state.sourceOffset = batch.sourceEnd;
    state.pendingBatch = null;
    await event('Обработан фрагмент исходника без полных заданий.');
    return;
  }
  await event('Независимая проверка: решение, переводы, объяснения, подсказки и чертежи.');
  const review = await runStructured('review', reviewPrompt, {
    questions: batch.questions.map(({ correctOption: _answer, ...q }, index) => ({ index, ...q })),
    topics: state.topics.filter(t => batch.questions.some(q => q.primaryTopicId === t.id)).map(t => ({ id: t.id, path: t.path })),
    history: state.questions.filter(q => q.validation.passed && q.generation.responseId !== generationCall.responseId
      && batch.questions.some(b => b.primaryTopicId === q.topic)).slice(-40).map(q => q.translations.kk.text),
  }, reviewSchema, id => { batch.reviewCallId = id; }, batch.reviewCallId, () => pauseRequested);
  if (review.data.reviews.length !== batch.questions.length
    || new Set(review.data.reviews.map(r => r.index)).size !== batch.questions.length
    || review.data.reviews.some(r => r.index >= batch.questions.length)) {
    throw new BatchContentError('Проверяющая модель не вернула однозначный результат для каждого задания');
  }
  for (const [index, generated] of batch.questions.entries()) {
    const id = hash(`${state.runId}:${generationCall.responseId}:${index}`).slice(0, 40);
    if (state.questions.some(q => q.id === id)) continue;
    const verdict = review.data.reviews.find(v => v.index === index)!;
    const issues = assessQuestion(generated, verdict, state.mode === 'generate' ? state.activeTopicId! : undefined);
    const fingerprint = questionFingerprint(generated);
    const question: StoredQuestion = {
      id, topic: generated.primaryTopicId, difficulty: generated.difficulty, correctOption: generated.correctOption,
      translations: generated.translations, diagram: generated.diagram, fingerprint,
      status: issues.length ? 'rejected' : 'draft', validation: { passed: issues.length === 0, issues },
      generation: { model: generationCall.model, reviewModel: review.model,
        responseId: generationCall.responseId!, reviewResponseId: review.responseId,
        ...(generationCall.researchResponseId ? {
          researchResponseId: generationCall.researchResponseId,
          referenceSources: generationCall.referenceSources || [],
        } : {}),
        runId: state.runId, createdAt: Date.now() },
    };
    if (question.validation.passed) {
      await event('Формирую необходимые изображения и сохраняю три языка в Firebase.', 'info', question.topic);
      await publishValidatedQuestion(question);
    }
    state.questions.push(question);
    await event(question.validation.passed ? `Задание сохранено: ${question.id.slice(0, 8)} · kk / ru / en.`
      : `Задание отправлено на исправление: ${issues.join('; ')}`, question.validation.passed ? 'success' : 'warning', question.topic);
  }
  if (batch.sourceEnd !== undefined) state.sourceOffset = batch.sourceEnd;
  const activeTopic = state.topics.find(t => t.id === state.activeTopicId);
  if (activeTopic && state.mode === 'generate') {
    const accepted = state.questions.some(q => q.generation.responseId === generationCall.responseId && q.validation.passed);
    activeTopic.failedBatches = accepted ? 0 : (activeTopic.failedBatches || 0) + 1;
    if (activeTopic.failedBatches >= config.maxTopicFailures) await event('Новые партии темы отложены; сначала исправляются отклонённые задания.', 'warning', activeTopic.id);
    activeTopic.requestFailures = 0;
  }
  state.pendingBatch = null;
  await save();
}

async function loop() {
  state.status = 'running'; state.error = null;
  await save();
  try {
    while (!pauseRequested) {
      try {
        if (state.pendingBatch) {
          await processBatch();
          continue;
        }
        if (state.generationCallId) {
          const active = state.topics.find(topic => topic.id === state.activeTopicId);
          if (!active) throw new Error('Не найдена тема сохранённого запроса');
          await generateBatch(active);
          continue;
        }
        const rejected = nextRepair();
        if (rejected) {
          await repairQuestion(rejected, () => pauseRequested);
          continue;
        }
        const topic = state.mode === 'parse' ? state.topics.find(t => t.eligible) : selectTopic();
        const sourceFinished = state.mode === 'parse' && state.sourceOffset >= state.sourceText.length;
        if (sourceFinished || (!topic && state.mode === 'generate')) {
          const deferred = state.topics.filter(t => t.eligible
            && (!state.selectedTopicIds.length || state.selectedTopicIds.includes(t.id))
            && ((t.failedBatches || 0) >= config.maxTopicFailures || (t.requestFailures || 0) >= config.maxTopicFailures));
          if (deferred.length && state.mode === 'generate') {
            state.status = 'paused';
            await event(`Доступные темы обработаны. Отложено тем после лимита попыток: ${deferred.length}.`, 'warning');
            return;
          }
          state.status = 'completed';
          await event('План выполнен. Все принятые задания сохранены в Firebase.');
          return;
        }
        if (!topic) throw new Error('Нет доступных тем для классификации');
        state.activeTopicId = topic.id;
        await generateBatch(topic);
      } catch (error) {
        if (error instanceof RequestPausedError) break;
        if (!(error instanceof RecoverableApiError || error instanceof BatchContentError) || state.mode === 'parse') throw error;
        const topic = state.topics.find(item => item.id === state.activeTopicId);
        if (topic) topic.requestFailures = (topic.requestFailures || 0) + 1;
        if (state.pendingBatch) {
          const batch = state.pendingBatch;
          const generation = state.calls.find(call => call.id === batch.generationCallId)!;
          const review = state.calls.find(call => call.id === batch.reviewCallId);
          for (const [index, generated] of batch.questions.entries()) {
            const id = hash(`${state.runId}:${generation.responseId}:${index}`).slice(0, 40);
            if (state.questions.some(question => question.id === id)) continue;
            state.questions.push({ id, topic: generated.primaryTopicId, difficulty: generated.difficulty,
              correctOption: generated.correctOption, translations: generated.translations, diagram: generated.diagram,
              fingerprint: questionFingerprint(generated), status: 'rejected',
              validation: { passed: false, issues: [`Проверка не завершена: ${safeError(error)}`] },
              generation: { model: generation.model, responseId: generation.responseId!,
                reviewModel: review?.model, reviewResponseId: review?.responseId || '', runId: state.runId, createdAt: Date.now(),
                ...(generation.researchResponseId ? { researchResponseId: generation.researchResponseId,
                  referenceSources: generation.referenceSources || [] } : {}) } });
          }
        }
        state.generationCallId = null;
        state.pendingBatch = null;
        await event(`Исчерпаны попытки запроса: ${safeError(error)}. Продолжаю остальные задания.`, 'warning', topic?.id);
      }
    }
    state.status = 'paused';
    await event('Пауза. Результаты и текущий этап сохранены.');
  } catch (error) {
    state.status = error instanceof BudgetError ? 'budget_exhausted' : 'error';
    state.error = safeError(error);
    await event(state.error, 'error');
  } finally {
    running = null;
    await save();
  }
}
export function startWorker() {
  if (running) throw new Error('Генерация уже выполняется');
  pauseRequested = false;
  running = loop();
  running.catch(error => {
    state.status = 'error'; state.error = safeError(error);
    process.stderr.write(`${state.error}\n`);
  });
}
export async function pauseWorker() {
  pauseRequested = true;
  if (running) await event('Останавливаюсь после текущего API-запроса; повторного списания при продолжении не будет.');
}
export async function waitForWorker() { await running; }
export const startSchema = z.strictObject({
  perTopic: z.number().int().min(10).max(200),
  batchSize: z.number().int().min(1).max(5),
  mode: z.enum(['generate', 'parse']),
  sourceText: z.string().max(200000).optional(),
  topicIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).max(500).optional(),
});
