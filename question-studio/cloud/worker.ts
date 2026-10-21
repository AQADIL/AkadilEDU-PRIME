import { z } from 'zod';
import { config } from './config.js';
import { state, event, save, safeError } from './store.js';
import { runStructured, BudgetError, RecoverableApiError, RequestPausedError, CloudYieldError, sha256 } from './provider.js';
import { generationPrompt, reviewPrompt } from '../src/prompts.js';
import { generationSchema, reviewSchema, languages, difficulties, type Difficulty, type StoredQuestion, type Topic } from '../src/schema.js';
import { saveQuestionToDatabase, uploadImage } from './database.js';
import { renderQuestion } from './render.js';
import { researchTopic } from './research.js';
import { assessQuestion, cloudNotation, cloudTextIssues, BatchContentError, publishValidatedQuestion, questionFingerprint } from './assessment.js';
import { nextRepair, repairQuestion } from './repair.js';

const hash = sha256;
const shouldPause = () => state.status !== 'running';

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

export function publishQuestions(ids: string[]) {
  if (ids.length !== 1) throw new Error('Cloud publication accepts one question per request');
  if (state.status === 'running') throw new Error('Публикация вручную доступна после паузы');
  for (const id of ids) {
    const question = state.questions.find(q => q.id === id);
    if (!question || !question.validation.passed) throw new Error('Публиковать можно только проверенные задания');
    const original = question.status;
    question.status = 'published';
    try { saveQuestionToDatabase(question); }
    catch (error) { question.status = original; throw error; }
    save();
  }
  event(`Опубликовано заданий: ${ids.length}.`);
}
export function rerenderQuestions(ids: string[]) {
  if (ids.length !== 1) throw new Error('Cloud rendering accepts one question per request');
  if (state.status === 'running') throw new Error('Обновление изображений доступно после паузы');
  for (const id of ids) {
    const question = state.questions.find(q => q.id === id && q.validation.passed);
    if (!question) throw new Error('Задание не прошло проверку');
    const textIssues = cloudTextIssues({ ...question, primaryTopicId: question.topic });
    if (textIssues.length) throw new Error(textIssues.join('; '));
    const images = renderQuestion(question);
    if (images) {
      for (const language of languages) question.translations[language].imageUrl = uploadImage(id, images[language]);
      saveQuestionToDatabase(question);
      save();
    }
  }
  event(`Изображения обновлены: ${ids.length} заданий.`);
}

function generateBatch(topic: Topic) {
  const existingGeneration = state.calls.find(call => call.id === state.generationCallId);
  const research = state.mode !== 'generate' ? undefined : existingGeneration
    ? existingGeneration.researchResponseId ? topic.research : undefined
    : researchTopic(topic, shouldPause);
  if (shouldPause()) return;
  const count = Math.min(state.mode === 'generate' && topic.generated === 0 ? 1 : state.config.batchSize, topic.target - topic.generated);
  const plan = difficultyPlan(count);
  const sourceEnd = Math.min(state.sourceText.length, state.sourceOffset + 12000);
  event(`${topic.name}: составляю ${count} заданий (${plan.join(', ')}).`, 'info', topic.id);
  const result = runStructured('generation', generationPrompt + cloudNotation, {
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
  }, state.generationCallId || undefined, shouldPause);
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
  save();
}

function processBatch() {
  const batch = state.pendingBatch!;
  const generationCall = state.calls.find(c => c.id === batch.generationCallId)!;
  if (!batch.questions.length) {
    if (batch.sourceEnd === undefined) throw new Error('Пустая партия генерации');
    state.sourceOffset = batch.sourceEnd;
    state.pendingBatch = null;
    event('Обработан фрагмент исходника без полных заданий.');
    return;
  }
  event('Независимая проверка: решение, переводы, объяснения, подсказки и чертежи.');
  const review = runStructured('review', reviewPrompt, {
    questions: batch.questions.map(({ correctOption: _answer, ...q }, index) => ({ index, ...q })),
    topics: state.topics.filter(t => batch.questions.some(q => q.primaryTopicId === t.id)).map(t => ({ id: t.id, path: t.path })),
    history: state.questions.filter(q => q.validation.passed && q.generation.responseId !== generationCall.responseId
      && batch.questions.some(b => b.primaryTopicId === q.topic)).slice(-40).map(q => q.translations.kk.text),
  }, reviewSchema, id => { batch.reviewCallId = id; }, batch.reviewCallId, shouldPause);
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
      event('Формирую необходимые изображения и сохраняю три языка в Firebase.', 'info', question.topic);
      publishValidatedQuestion(question);
    }
    state.questions.push(question);
    event(question.validation.passed ? `Задание сохранено: ${question.id.slice(0, 8)} · kk / ru / en.`
      : `Задание отправлено на исправление: ${issues.join('; ')}`, question.validation.passed ? 'success' : 'warning', question.topic);
    return;
  }
  if (batch.sourceEnd !== undefined) state.sourceOffset = batch.sourceEnd;
  const activeTopic = state.topics.find(t => t.id === state.activeTopicId);
  if (activeTopic && state.mode === 'generate') {
    const accepted = state.questions.some(q => q.generation.responseId === generationCall.responseId && q.validation.passed);
    activeTopic.failedBatches = accepted ? 0 : (activeTopic.failedBatches || 0) + 1;
    if (activeTopic.failedBatches >= config.maxTopicFailures) event('Новые партии темы отложены; сначала исправляются отклонённые задания.', 'warning', activeTopic.id);
    activeTopic.requestFailures = 0;
  }
  state.pendingBatch = null;
  save();
}

export function isTemporaryGoogleFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof z.ZodError) return false;
  const message = error.message.replace(/^Exception:\s*/, '');
  return /^(?:Service invoked too many times|Service using too much computer time|There are too many scripts running simultaneously|Too many simultaneous invocations)/i.test(message)
    || /^(?:Service unavailable|Internal error|We're sorry, a server error occurred|A server error occurred):?(?:\s|$)/i.test(message)
    || /^(?:Exceeded maximum execution time|Limit exceeded: (?:Script runtime|URL Fetch calls|Service calls|Daily quota))/i.test(message);
}

export function runWorkerStep() {
  if (state.status !== 'running') return;
  try {
    if (state.pendingBatch) { processBatch(); return; }
    if (state.generationCallId) {
      const active = state.topics.find(topic => topic.id === state.activeTopicId);
      if (!active) throw new Error('Не найдена тема сохранённого запроса');
      generateBatch(active);
      return;
    }
    const rejected = nextRepair();
    if (rejected) { repairQuestion(rejected, shouldPause); return; }
    const topic = state.mode === 'parse' ? state.topics.find(item => item.eligible) : selectTopic();
    const sourceFinished = state.mode === 'parse' && state.sourceOffset >= state.sourceText.length;
    if (sourceFinished || (!topic && state.mode === 'generate')) {
      const deferred = state.topics.filter(item => item.eligible
        && (!state.selectedTopicIds.length || state.selectedTopicIds.includes(item.id))
        && ((item.failedBatches || 0) >= config.maxTopicFailures || (item.requestFailures || 0) >= config.maxTopicFailures));
      state.status = deferred.length && state.mode === 'generate' ? 'paused' : 'completed';
      event(state.status === 'paused' ? `Темы отложены после лимита попыток: ${deferred.length}.`
        : 'План выполнен. Все принятые задания сохранены в Firebase.');
      return;
    }
    if (!topic) throw new Error('Нет доступных тем для классификации');
    state.activeTopicId = topic.id;
    generateBatch(topic);
  } catch (error) {
    if (error instanceof CloudYieldError) return;
    if (isTemporaryGoogleFailure(error) && !state.calls.some(call => call.status === 'uncertain' || call.status === 'reserved')) return;
    if (error instanceof RequestPausedError) { state.status = 'paused'; return; }
    try {
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
      event(`Исчерпаны попытки запроса: ${safeError(error)}. Продолжаю остальные задания.`, 'warning', topic?.id);
    } catch (failure) {
      state.status = failure instanceof BudgetError ? 'budget_exhausted' : 'error';
      state.error = safeError(failure);
      event(state.error, 'error');
    }
  } finally {
    try { save(); }
    catch (error) {
      if (isTemporaryGoogleFailure(error)) throw new CloudYieldError('Google state storage is temporarily unavailable; the committed state will be retried.');
      throw error;
    }
  }
}
export const startSchema = z.strictObject({
  perTopic: z.number().int().min(10).max(200),
  batchSize: z.number().int().min(1).max(5),
  mode: z.enum(['generate', 'parse']),
  sourceText: z.string().max(200000).optional(),
  topicIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).max(500).optional(),
});
