import { z } from 'zod';
import { sha256 } from './provider.js';
import { config } from './config.js';
import { state, safeError } from './store.js';
import { contentIssues, languages, reviewSchema, type GeneratedQuestion, type StoredQuestion } from '../src/schema.js';
import { renderQuestion, QuestionRenderError } from './render.js';
import { saveQuestionToDatabase, uploadImage } from './database.js';
import { layoutStatement, MathLayoutError } from './math-layout.js';
import { statementPresentation } from '../src/statementPresentation.js';

export type Verdict = z.infer<typeof reviewSchema>['reviews'][number];
export class BatchContentError extends Error {}
export const cloudNotation = `\nRender statement fractions and complex expressions as delimited LaTeX, with translated instructions outside the formula block and the same formula across languages only when all notation is genuinely language-neutral; local operator names require translated text or separate local images. The cloud renderer supports frac/dfrac/tfrac, sqrt (including indexed roots), upper/lower indices, left/right delimiters, overline, binom, plain text/operator names, standard Greek letters and arithmetic/relation/trigonometric/logarithmic symbols, and cases/aligned/gathered/matrix/pmatrix/bmatrix/vmatrix environments. Use these supported constructs; preserve mathematical meaning. Put no LaTeX or image references in options, explanations, hints or diagram labels: these fields must remain readable Unicode. Diagram labels should be language-neutral where possible. Never include the translated instruction inside an image when it can be separated without losing meaning.`;
export function cloudTextIssues(question: GeneratedQuestion): string[] {
  const issues: string[] = [];
  for (const language of languages) {
    const translation = question.translations[language];
    const diagramText = question.diagram ? [question.diagram.caption[language],
      ...question.diagram.points.map(point => point.label[language]),
      ...question.diagram.angles.map(angle => angle.label[language]),
      ...question.diagram.labels.map(label => label.text[language])] : [];
    if ([...translation.options, translation.explanation, translation.hint, ...diagramText]
      .some(text => /\\[A-Za-z]+|\\[()[\]]|\$\$?|\^\{|_\{/.test(text))) {
      issues.push(`${language}: options, explanation, hint and diagram labels must use readable Unicode notation without LaTeX; only the statement supports formula images.`);
    }
    const statement = statementPresentation(translation.text);
    if (statement.imageText) try { layoutStatement(statement.imageText, 672); }
    catch (error) { if (error instanceof MathLayoutError) issues.push(`${language}: ${error.message}`); else throw error; }
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
    if (config.autoPublish) {
      question.status = 'published';
      question.publishedAt = Date.now();
    }
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
