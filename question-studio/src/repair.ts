import { z } from 'zod';
import { config } from './config.js';
import { state, save, event, safeError } from './store.js';
import { runStructured, RecoverableApiError, RequestPausedError } from './provider.js';
import { generatedQuestionSchema, generatedQuestionContent as questionInput, restoreGeneratedQuestion, reviewSchema, type StoredQuestion } from './schema.js';
import { repairPrompt, reviewPrompt } from './prompts.js';
import { assessQuestion, BatchContentError, publishValidatedQuestion, questionFingerprint } from './assessment.js';
import { QuestionConflictError } from './database.js';
import { RenderRetryError } from './render.js';
import { hasSchoolNotationIssue } from './questionPresentation.js';

const repairSchema = z.strictObject({ question: generatedQuestionSchema });
export function nextRepair(excludedTopics: ReadonlySet<string> = new Set(), readyAt = Date.now(), excludedIds: ReadonlySet<string> = new Set()): StoredQuestion | undefined {
  const candidates = state.questions.filter(question => !question.validation.passed
    && !excludedIds.has(question.id)
    && !excludedTopics.has(question.topic)
    && (question.repair?.retryAt ?? 0) <= readyAt
    && (!state.selectedTopicIds.length || state.selectedTopicIds.includes(question.topic))
    && state.topics.some(topic => topic.id === question.topic && topic.eligible)
    && question.repair?.status !== 'exhausted' && question.repair?.status !== 'completed'
    && (question.repair?.status === 'running' || (question.repair?.attempts || 0) < config.repairMaxAttempts));
  return candidates.find(question => hasSchoolNotationIssue(question.validation.issues)) ?? candidates[0];
}
export async function repairQuestion(question: StoredQuestion, shouldPause: () => boolean): Promise<void> {
  question.repair ??= { attempts: 0, status: 'pending', history: [{ attempt: 0,
    issues: [...question.validation.issues], generationResponseId: question.generation.responseId,
    reviewResponseId: question.generation.reviewResponseId }] };
  const repair = question.repair;
  if (!repair.originalQuestion) {
    repair.originalQuestion = questionInput(question);
    await save();
  }
  delete repair.retryAt;
  if (repair.status !== 'running') {
    if (shouldPause()) throw new RequestPausedError();
    repair.attempts += 1;
    repair.status = 'running';
    await save();
  }
  const topic = state.topics.find(item => item.id === question.topic)!;
  try {
    if (!repair.candidate) {
      await event(`Исправление ${question.id.slice(0, 8)}: попытка ${repair.attempts}/${config.repairMaxAttempts}, замечания переданы ${config.model}.`, 'info', question.topic);
      const result = await runStructured('repair', repairPrompt, {
        question: questionInput(question), originalQuestion: repair.originalQuestion, topic: { id: topic.id, path: topic.path },
        feedback: question.validation.issues, previousAttempts: repair.history.map(item => ({ attempt: item.attempt, issues: item.issues })),
        history: state.questions.filter(item => item.id !== question.id && item.topic === question.topic && item.validation.passed)
          .slice(-40).map(item => item.translations.kk.text),
      }, repairSchema, id => {
        repair.generationCallId = id;
        const call = state.calls.find(item => item.id === id)!;
        if (question.generation.researchResponseId) {
          call.researchResponseId = question.generation.researchResponseId;
          call.referenceSources = question.generation.referenceSources;
        }
      }, repair.generationCallId, shouldPause);
      repair.candidate = result.data.question;
      await save();
    }
    if (shouldPause()) throw new RequestPausedError();
    const candidate = repair.candidate;
    const { correctOption: _answer, ...reviewInput } = candidate;
    const { correctOption: _originalAnswer, ...originalQuestion } = repair.originalQuestion;
    await event(`Повторная проверка ${question.id.slice(0, 8)}: ${config.reviewModel}.`, 'info', question.topic);
    const reviewed = await runStructured('review', reviewPrompt, {
      originalQuestion, changesRequested: question.validation.issues,
      questions: [{ ...reviewInput, index: 0 }], topics: [{ id: topic.id, path: topic.path }],
      history: state.questions.filter(item => item.id !== question.id && item.topic === question.topic && item.validation.passed)
        .slice(-40).map(item => item.translations.kk.text),
    }, reviewSchema, id => { repair.reviewCallId = id; }, repair.reviewCallId, shouldPause);
    if (repair.originalReviewRequired) {
      delete repair.reviewCallId;
      delete repair.originalReviewRequired;
      await save();
      return repairQuestion(question, shouldPause);
    }
    if (reviewed.data.reviews.length !== 1 || reviewed.data.reviews[0]!.index !== 0) {
      throw new BatchContentError('Проверка исправления вернула неверное соответствие заданию');
    }
    const generation = state.calls.find(call => call.id === repair.generationCallId)!;
    const issues = assessQuestion(candidate, reviewed.data.reviews[0]!, question.topic, question.id);
    const content = restoreGeneratedQuestion(candidate);
    const corrected: StoredQuestion = {
      ...question, difficulty: candidate.difficulty, correctOption: candidate.correctOption,
      translations: content.translations, diagram: content.diagram, fingerprint: questionFingerprint(candidate),
      validation: { passed: issues.length === 0, issues }, status: issues.length ? 'rejected' : 'draft',
      generation: { ...question.generation, model: generation.model, responseId: generation.responseId!,
        reviewModel: reviewed.model, reviewResponseId: reviewed.responseId },
    };
    const passed = await publishValidatedQuestion(corrected);
    repair.history.push({ attempt: repair.attempts, issues: [...corrected.validation.issues],
      generationResponseId: generation.responseId, reviewResponseId: reviewed.responseId });
    repair.status = passed ? 'completed' : repair.attempts >= config.repairMaxAttempts ? 'exhausted' : 'pending';
    delete repair.candidate;
    delete repair.generationCallId;
    delete repair.reviewCallId;
    Object.assign(question, corrected, { repair });
    if (passed) { topic.failedBatches = 0; topic.requestFailures = 0; }
    await event(passed ? `Исправлено и сохранено: ${question.id.slice(0, 8)} · ${question.difficulty} · kk / ru / en.`
      : `Исправление ${question.id.slice(0, 8)} ${repair.status === 'exhausted' ? 'отложено после лимита попыток' : 'возвращено на доработку'}: ${question.validation.issues.join('; ')}`,
    passed ? 'success' : 'warning', question.topic);
  } catch (error) {
    if (error instanceof RenderRetryError) throw error;
    if (error instanceof QuestionConflictError) {
      repair.status = 'exhausted';
      repair.history.push({ attempt: repair.attempts, issues: [safeError(error)] });
      delete repair.candidate;
      delete repair.generationCallId;
      delete repair.reviewCallId;
      await event(`Исправление ${question.id.slice(0, 8)} пропущено: ${safeError(error)} Остальные задания продолжают обрабатываться.`, 'warning', question.topic);
      return;
    }
    if (!(error instanceof RecoverableApiError || error instanceof BatchContentError)) throw error;
    const generation = state.calls.find(call => call.id === repair.generationCallId);
    const review = state.calls.find(call => call.id === repair.reviewCallId);
    repair.history.push({ attempt: repair.attempts, issues: [safeError(error)],
      ...(generation?.responseId ? { generationResponseId: generation.responseId } : {}),
      ...(review?.responseId ? { reviewResponseId: review.responseId } : {}) });
    repair.status = repair.attempts >= config.repairMaxAttempts ? 'exhausted' : 'pending';
    delete repair.candidate;
    delete repair.generationCallId;
    delete repair.reviewCallId;
    await event(`Исправление ${question.id.slice(0, 8)}: ${safeError(error)}. ${repair.status === 'exhausted' ? 'Попытки исчерпаны; продолжаю остальные задания.' : 'Следующая попытка использует сохранённые замечания.'}`, 'warning', question.topic);
  }
}
