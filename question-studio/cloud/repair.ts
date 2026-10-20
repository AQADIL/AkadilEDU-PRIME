import { z } from 'zod';
import { config } from './config.js';
import { state, save, event, safeError } from './store.js';
import { runStructured, RecoverableApiError, RequestPausedError } from './provider.js';
import { generatedQuestionSchema, reviewSchema, languages, type GeneratedQuestion, type StoredQuestion } from '../src/schema.js';
import { repairPrompt, reviewPrompt } from '../src/prompts.js';
import { assessQuestion, cloudNotation, BatchContentError, publishValidatedQuestion, questionFingerprint } from './assessment.js';

const repairSchema = z.strictObject({ question: generatedQuestionSchema });
function questionInput(question: StoredQuestion): GeneratedQuestion {
  const translations = Object.fromEntries(languages.map(language => {
    const { text, options, explanation, hint } = question.translations[language];
    return [language, { text, options, explanation, hint }];
  }));
  return generatedQuestionSchema.parse({ primaryTopicId: question.topic, difficulty: question.difficulty,
    correctOption: question.correctOption, diagram: question.diagram, translations });
}
export function nextRepair(): StoredQuestion | undefined {
  return state.questions.find(question => !question.validation.passed
    && (!state.selectedTopicIds.length || state.selectedTopicIds.includes(question.topic))
    && state.topics.some(topic => topic.id === question.topic && topic.eligible)
    && question.repair?.status !== 'exhausted' && question.repair?.status !== 'completed'
    && (question.repair?.status === 'running' || (question.repair?.attempts || 0) < config.repairMaxAttempts));
}
export function repairQuestion(question: StoredQuestion, shouldPause: () => boolean) {
  question.repair ??= { attempts: 0, status: 'pending', history: [{ attempt: 0,
    issues: [...question.validation.issues], generationResponseId: question.generation.responseId,
    reviewResponseId: question.generation.reviewResponseId }] };
  const repair = question.repair;
  if (repair.status !== 'running') {
    if (shouldPause()) throw new RequestPausedError();
    repair.attempts += 1;
    repair.status = 'running';
    save();
  }
  const topic = state.topics.find(item => item.id === question.topic)!;
  try {
    if (!repair.candidate) {
      event(`Исправление ${question.id.slice(0, 8)}: попытка ${repair.attempts}/${config.repairMaxAttempts}, замечания переданы ${config.model}.`, 'info', question.topic);
      const result = runStructured('repair', repairPrompt + cloudNotation,  {
        question: questionInput(question), topic: { id: topic.id, path: topic.path },
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
      save();
    }
    if (shouldPause()) throw new RequestPausedError();
    const candidate = repair.candidate;
    const { correctOption: _answer, ...reviewInput } = candidate;
    event(`Повторная проверка ${question.id.slice(0, 8)}: ${config.reviewModel}.`, 'info', question.topic);
    const reviewed = runStructured('review', reviewPrompt, {
      questions: [{ ...reviewInput, index: 0 }], topics: [{ id: topic.id, path: topic.path }],
      history: state.questions.filter(item => item.id !== question.id && item.topic === question.topic && item.validation.passed)
        .slice(-40).map(item => item.translations.kk.text),
    }, reviewSchema, id => { repair.reviewCallId = id; }, repair.reviewCallId, shouldPause);
    if (reviewed.data.reviews.length !== 1 || reviewed.data.reviews[0]!.index !== 0) {
      throw new BatchContentError('Проверка исправления вернула неверное соответствие заданию');
    }
    const generation = state.calls.find(call => call.id === repair.generationCallId)!;
    const issues = assessQuestion(candidate, reviewed.data.reviews[0]!, question.topic, question.id);
    const corrected: StoredQuestion = {
      ...question, difficulty: candidate.difficulty, correctOption: candidate.correctOption,
      translations: candidate.translations, diagram: candidate.diagram, fingerprint: questionFingerprint(candidate),
      validation: { passed: issues.length === 0, issues }, status: issues.length ? 'rejected' : 'draft',
      generation: { ...question.generation, model: generation.model, responseId: generation.responseId!,
        reviewModel: reviewed.model, reviewResponseId: reviewed.responseId },
    };
    const passed = publishValidatedQuestion(corrected);
    repair.history.push({ attempt: repair.attempts, issues: [...corrected.validation.issues],
      generationResponseId: generation.responseId, reviewResponseId: reviewed.responseId });
    repair.status = passed ? 'completed' : repair.attempts >= config.repairMaxAttempts ? 'exhausted' : 'pending';
    delete repair.candidate;
    delete repair.generationCallId;
    delete repair.reviewCallId;
    Object.assign(question, corrected, { repair });
    if (passed) { topic.failedBatches = 0; topic.requestFailures = 0; }
    event(passed ? `Исправлено и сохранено: ${question.id.slice(0, 8)} · ${question.difficulty} · kk / ru / en.`
      : `Исправление ${question.id.slice(0, 8)} ${repair.status === 'exhausted' ? 'отложено после лимита попыток' : 'возвращено на доработку'}: ${question.validation.issues.join('; ')}`,
    passed ? 'success' : 'warning', question.topic);
  } catch (error) {
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
    event(`Исправление ${question.id.slice(0, 8)}: ${safeError(error)}. ${repair.status === 'exhausted' ? 'Попытки исчерпаны; продолжаю остальные задания.' : 'Следующая попытка использует сохранённые замечания.'}`, 'warning', question.topic);
  }
}
