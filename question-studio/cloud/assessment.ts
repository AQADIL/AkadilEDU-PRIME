import { z } from 'zod';
import { sha256 } from './provider.js';
import { config } from './config.js';
import { state, safeError } from './store.js';
import { contentIssues, languages, reviewSchema, type GeneratedQuestion, type StoredQuestion } from '../src/schema.js';
import { renderQuestion, QuestionRenderError } from './render.js';
import { saveQuestionToDatabase, uploadImage } from './database.js';

export type Verdict = z.infer<typeof reviewSchema>['reviews'][number];
export class BatchContentError extends Error {}
export const cloudNotation = '\nAll statements, answer options, explanations, hints and diagram labels are displayed as plain text. Use exact readable Unicode mathematical notation and parentheses for fraction grouping. Do not output LaTeX commands or delimiters anywhere. Preserve mathematical meaning and all necessary diagrams.';
export function cloudTextIssues(question: GeneratedQuestion): string[] {
  const issues: string[] = [];
  for (const language of languages) {
    const translation = question.translations[language];
    const diagramText = question.diagram ? [question.diagram.caption[language],
      ...question.diagram.points.map(point => point.label[language]),
      ...question.diagram.angles.map(angle => angle.label[language]),
      ...question.diagram.labels.map(label => label.text[language])] : [];
    if ([translation.text, ...translation.options, translation.explanation, translation.hint, ...diagramText]
      .some(text => /\\[A-Za-z]+|\\[()[\]]|\$\$?|\^\{|_\{/.test(text))) {
      issues.push(`${language}: replace LaTeX with mathematically equivalent readable Unicode notation; the cloud output is plain text.`);
    }
  }
  return issues;
}

export function questionFingerprint(question: GeneratedQuestion): string {
  const text = question.translations.kk.text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return sha256(`${question.primaryTopicId}:${text}`);
}
export function assessQuestion(question: GeneratedQuestion, verdict: Verdict, expectedTopic?: string, excludeId?: string): string[] {
  const issues = [...contentIssues(question), ...cloudTextIssues(question)];
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
export function publishValidatedQuestion(question: StoredQuestion): boolean {
  if (!question.validation.passed) return false;
  try {
    const images = renderQuestion(question);
    if (images) for (const language of languages) question.translations[language].imageUrl = uploadImage(question.id, images[language]);
    if (config.autoPublish) question.status = 'published';
    saveQuestionToDatabase(question);
    return true;
  } catch (error) {
    if (!(error instanceof QuestionRenderError)) throw error;
    question.status = 'rejected';
    question.validation.passed = false;
    question.validation.issues.push(safeError(error));
    return false;
  }
}
