import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { state, event, save, safeError } from './store.js';
import { runStructured, BudgetError } from './provider.js';
import { generationPrompt, reviewPrompt } from './prompts.js';
import { generationSchema, reviewSchema, contentIssues, languages, difficulties, type Difficulty, type StoredQuestion, type Topic } from './schema.js';
import { saveQuestionToDatabase, uploadImage } from './database.js';
import { DiagramLayoutError, renderQuestion } from './render.js';
import { researchTopic } from './research.js';

let running: Promise<void> | null = null;
let pauseRequested = false;
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function selectTopic(): Topic | undefined {
  return state.topics.filter(t => t.eligible && (!state.selectedTopicIds.length || state.selectedTopicIds.includes(t.id))
    && (t.failedBatches || 0) < 3 && t.generated < t.target).sort((a, b) => a.generated - b.generated || a.id.localeCompare(b.id))[0];
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
  const research = state.mode === 'generate' && !state.generationCallId ? await researchTopic(topic) : undefined;
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
  }, state.generationCallId || undefined);
  if (state.mode === 'generate' && result.data.questions.length !== count) throw new Error('Модель вернула неверное количество вопросов');
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
    history: state.questions.filter(q => batch.questions.some(b => b.primaryTopicId === q.topic)).slice(-40).map(q => q.translations.kk.text),
  }, reviewSchema, id => { batch.reviewCallId = id; }, batch.reviewCallId);
  if (review.data.reviews.length !== batch.questions.length
    || new Set(review.data.reviews.map(r => r.index)).size !== batch.questions.length
    || review.data.reviews.some(r => r.index >= batch.questions.length)) {
    throw new Error('Проверяющая модель не вернула однозначный результат для каждого задания');
  }
  for (const [index, generated] of batch.questions.entries()) {
    const id = hash(`${state.runId}:${generationCall.responseId}:${index}`).slice(0, 40);
    if (state.questions.some(q => q.id === id)) continue;
    const verdict = review.data.reviews.find(v => v.index === index)!;
    const issues = contentIssues(generated);
    const topic = state.topics.find(t => t.id === generated.primaryTopicId && t.eligible);
    if (!topic) issues.push('Неизвестная или служебная тема');
    if (state.mode === 'generate' && generated.primaryTopicId !== state.activeTopicId) issues.push('Модель изменила выбранную тему');
    const checkNames = ['uniqueAnswer', 'mathematicallyCorrect', 'translationsEquivalent', 'explanationsCorrect',
      'hintsHelpful', 'topicMatches', 'difficultyMatches', 'diagramCorrect'] as const;
    for (const name of checkNames) if (!verdict[name]) issues.push(`Проверка не пройдена: ${name}`);
    if (verdict.correctOption !== generated.correctOption) issues.push('Независимое решение дало другой правильный ответ');
    if (verdict.needsDiagram && !generated.diagram) issues.push('Отсутствует необходимый рисунок');
    issues.push(...verdict.issues);
    const fingerprint = hash(`${generated.primaryTopicId}:${normalize(generated.translations.kk.text)}`);
    if (state.questions.some(q => q.fingerprint === fingerprint)) issues.push('Повтор задания');
    let passed = issues.length === 0;
    const question: StoredQuestion = {
      id, topic: generated.primaryTopicId, difficulty: generated.difficulty, correctOption: generated.correctOption,
      translations: generated.translations, diagram: generated.diagram, fingerprint,
      status: passed ? 'draft' : 'rejected', validation: { passed, issues },
      generation: { model: generationCall.model, reviewModel: review.model,
        responseId: generationCall.responseId!, reviewResponseId: review.responseId,
        ...(generationCall.researchResponseId ? {
          researchResponseId: generationCall.researchResponseId,
          referenceSources: generationCall.referenceSources || [],
        } : {}),
        runId: state.runId, createdAt: Date.now() },
    };
    if (passed) {
      await event('Формирую необходимые изображения и сохраняю три языка в Firebase.', 'info', question.topic);
      try {
        const images = await renderQuestion(question);
        if (images) {
          for (const language of languages) question.translations[language].imageUrl = await uploadImage(id, images[language]);
        }
        if (config.autoPublish) question.status = 'published';
        await saveQuestionToDatabase(question);
      } catch (error) {
        if (!(error instanceof DiagramLayoutError)) throw error;
        passed = false;
        question.status = 'rejected';
        question.validation.passed = false;
        issues.push(safeError(error));
      }
    }
    state.questions.push(question);
    await event(passed ? `Задание сохранено: ${question.id.slice(0, 8)} · kk / ru / en.`
      : `Задание отклонено: ${issues.join('; ')}`, passed ? 'success' : 'warning', question.topic);
  }
  if (batch.sourceEnd !== undefined) state.sourceOffset = batch.sourceEnd;
  const activeTopic = state.topics.find(t => t.id === state.activeTopicId);
  if (activeTopic && state.mode === 'generate') {
    const accepted = state.questions.some(q => q.generation.responseId === generationCall.responseId && q.validation.passed);
    activeTopic.failedBatches = accepted ? 0 : (activeTopic.failedBatches || 0) + 1;
    if (activeTopic.failedBatches >= 3) await event('Тема отложена после трёх отклонённых партий; требуется разбор причин.', 'warning', activeTopic.id);
  }
  state.pendingBatch = null;
  await save();
}

async function loop() {
  state.status = 'running'; state.error = null;
  await save();
  try {
    while (!pauseRequested) {
      if (!state.pendingBatch) {
        const topic = state.mode === 'parse' ? state.topics.find(t => t.eligible) : selectTopic();
        const sourceFinished = state.mode === 'parse' && state.sourceOffset >= state.sourceText.length;
        if (sourceFinished || (!topic && state.mode === 'generate')) {
          const deferred = state.topics.filter(t => t.eligible && (t.failedBatches || 0) >= 3);
          if (deferred.length && state.mode === 'generate') {
            state.status = 'paused';
            await event(`Генерация остановлена: ${deferred.length} тем требуют разбора отклонённых заданий.`, 'warning');
            return;
          }
          state.status = 'completed';
          await event('План выполнен. Все принятые задания сохранены в Firebase.');
          return;
        }
        if (!topic) throw new Error('Нет доступных тем для классификации');
        state.activeTopicId = topic.id;
        await generateBatch(topic);
      }
      if (pauseRequested) break;
      await processBatch();
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
