import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { state, safeError } from './store.js';
import { contentIssues, languages, reviewSchema, type GeneratedQuestion, type StoredQuestion } from './schema.js';
import { renderQuestion, QuestionRenderError } from './render.js';
import { saveQuestionToDatabase, uploadImage } from './database.js';

export type Verdict = z.infer<typeof reviewSchema>['reviews'][number];
export class BatchContentError extends Error {}
export function questionFingerprint(question: GeneratedQuestion): string {
  const text = question.translations.kk.text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${question.primaryTopicId}:${text}`).digest('hex');
}
export function assessQuestion(question: GeneratedQuestion, verdict: Verdict, expectedTopic?: string, excludeId?: string): string[] {
  const issues = contentIssues(question);
  if (!state.topics.some(topic => topic.id === question.primaryTopicId && topic.eligible)) issues.push('Неизвестная или служебная тема');
  if (expectedTopic && question.primaryTopicId !== expectedTopic) issues.push('Модель изменила выбранную тему');
  const checks = ['uniqueAnswer', 'mathematicallyCorrect', 'translationsEquivalent', 'explanationsCorrect',
    'hintsHelpful', 'topicMatches', 'difficultyMatches', 'diagramCorrect'] as const;
  for (const check of checks) if (!verdict[check]) issues.push(`Проверка не пройдена: ${check}`);
  if (verdict.correctOption !== question.correctOption) issues.push('Независимое решение дало другой правильный ответ');
  if (verdict.needsDiagram && !question.diagram) issues.push('Отсутствует необходимый рисунок');
  const fingerprint = questionFingerprint(question);
  if (state.questions.some(existing => existing.id !== excludeId && existing.validation.passed && existing.fingerprint === fingerprint)) {
    issues.push('Повтор задания');
  }
  return [...new Set([...issues, ...verdict.issues])];
}
export async function publishValidatedQuestion(question: StoredQuestion): Promise<boolean> {
  if (!question.validation.passed) return false;
  try {
    const images = await renderQuestion(question);
    if (images) for (const language of languages) question.translations[language].imageUrl = await uploadImage(question.id, images[language]);
    if (config.autoPublish) question.status = 'published';
    await saveQuestionToDatabase(question);
    return true;
  } catch (error) {
    if (!(error instanceof QuestionRenderError)) throw error;
    question.status = 'rejected';
    question.validation.passed = false;
    question.validation.issues.push(safeError(error));
    return false;
  }
}
