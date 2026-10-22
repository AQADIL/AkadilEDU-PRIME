import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, updateQuestionAtomically } from './database.js';
import { config } from './config.js';
import { state, event, save } from './store.js';
import { restoreGeneratedQuestion, generatedQuestionContent, languages, type GeneratedQuestion, type StoredQuestion } from './schema.js';
import { questionPresentationIssues } from './questionPresentation.js';
import { statementPresentation } from './statementPresentation.js';

const recordSchema = z.object({
  generation: z.object({ runId: z.string(), responseId: z.string() }),
  fingerprint: z.string(), topic: z.string(), difficulty: z.string(), correctOption: z.number(),
  diagram: z.unknown().optional(), updatedAt: z.number(),
  translations: z.record(z.string(), z.object({ text: z.string(), options: z.array(z.string()),
    explanation: z.string(), hint: z.string(), imageUrl: z.string().optional() })),
});
const presentationIssue = /Дробь в условии|Степень или индекс|Длинные индексы|Основание логарифма|Корень со сложным|Условие содержит|вариант \d+/u;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? value.map(canonical) : null;
  if (!value || typeof value !== 'object') return value ?? null;
  const entries = Object.entries(value).map(([key, item]) => [key, canonical(item)] as const)
    .filter(([, item]) => item !== null).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? Object.fromEntries(entries) : null;
}

function matchesSource(value: unknown, source: GeneratedQuestion, question?: StoredQuestion): boolean {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) return false;
  const record = parsed.data;
  return record.topic === source.primaryTopicId && record.difficulty === source.difficulty
    && record.correctOption === source.correctOption
    && JSON.stringify(canonical(record.diagram)) === JSON.stringify(canonical(source.diagram))
    && (!question || (record.generation.runId === question.generation.runId && record.fingerprint === question.fingerprint))
    && languages.every(language => {
      const translation = record.translations[language];
      const expected = source.translations[language];
      return translation?.text === statementPresentation(expected.text).displayText
        && JSON.stringify(translation.options) === JSON.stringify(expected.options)
        && translation.explanation === expected.explanation && translation.hint === expected.hint
        && (!question || (translation.imageUrl ?? '') === (question.translations[language].imageUrl ?? ''));
    });
}

function recoverOriginal(question: StoredQuestion, responseId: string): GeneratedQuestion | undefined {
  const call = state.calls.find(item => item.responseId === responseId);
  if (!call?.result || typeof call.result !== 'object') return;
  const result = call.result as Record<string, unknown>;
  const candidate = call.kind === 'repair' ? result.question : Array.isArray(result.questions)
    ? result.questions.find((_, index) => createHash('sha256').update(`${question.generation.runId}:${responseId}:${index}`).digest('hex').slice(0, 40) === question.id)
    : undefined;
  try { return restoreGeneratedQuestion(candidate); } catch { return; }
}

export async function queuePresentationRepairs(): Promise<void> {
  const snapshot = await db.ref('questions').get();
  const recheck = new Set<string>();
  for (const question of state.questions) {
    const repair = question.repair;
    if (!repair) continue;
    if (repair.originalQuestion) {
      if (repair.status === 'completed' && repair.originalReviewRequired) recheck.add(question.id);
      continue;
    }
    const baseline = repair.history.findLast(entry => entry.attempt === 0 && entry.issues.some(issue => presentationIssue.test(issue)));
    if (!baseline?.generationResponseId) continue;
    const blockedByRestore = repair.status === 'exhausted' && state.events.some(entry =>
      entry.message === `Исходник ${question.id.slice(0, 8)} не найден в сохранённых ответах; автоматическая замена пропущена.`);
    const reviewNeedsOriginal = repair.attempts > 1 && Boolean(repair.reviewCallId);
    const original = recoverOriginal(question, baseline.generationResponseId);
    if (!original) {
      repair.status = 'exhausted';
      await event(`Исходник ${question.id.slice(0, 8)} не найден в сохранённых ответах; автоматическая замена пропущена.`, 'warning', question.topic);
      continue;
    }
    repair.originalQuestion = original;
    if (repair.status === 'completed' && repair.attempts > 1) {
      repair.originalReviewRequired = true;
      recheck.add(question.id);
    }
    else if (repair.status !== 'completed') {
      const stored = snapshot.child(question.id).val() as unknown;
      const parsed = recordSchema.safeParse(stored);
      if (parsed.success && matchesSource(stored, original)) {
        repair.databaseRevision = parsed.data.updatedAt;
        if (blockedByRestore) {
          repair.status = 'pending';
          repair.attempts = 0;
        }
      }
      else {
        repair.status = 'exhausted';
        await event(`Задание ${question.id.slice(0, 8)} изменено вне студии или удалено; автоматическая замена пропущена.`, 'warning', question.topic);
      }
      if (reviewNeedsOriginal) repair.originalReviewRequired = true;
    }
  }
  await save();
  const candidates = state.questions.filter(question => question.validation.passed)
    .map(question => ({ question, issues: questionPresentationIssues(question.translations) }))
    .map(candidate => recheck.has(candidate.question.id) ? { ...candidate,
      issues: [...candidate.issues, 'Повторно сравните исправленное задание с неизменяемым исходником; при исправлении только оформления математический смысл должен сохраняться.'] } : candidate)
    .filter(candidate => candidate.issues.length);
  let queued = 0;
  for (let offset = 0; offset < candidates.length; offset += config.concurrency) {
    await Promise.all(candidates.slice(offset, offset + config.concurrency).map(async ({ question, issues }) => {
      const revision = Date.now();
      const source = generatedQuestionContent(question);
      const result = await updateQuestionAtomically(db.ref(`questions/${question.id}`), current => {
        if (!matchesSource(current, source, question) || !current || typeof current !== 'object') return;
        return { ...current, status: 'draft', validation: { passed: false, issues }, updatedAt: revision };
      });
      if (!result.committed) {
        await event(`Задание ${question.id.slice(0, 8)} изменено вне студии или удалено; автоматическая замена пропущена.`, 'warning', question.topic);
        return;
      }
      const completedReview = recheck.has(question.id) ? state.calls.find(call => call.kind === 'repair' && call.responseId === question.generation.responseId) : undefined;
      const original = recheck.has(question.id) ? question.repair!.originalQuestion! : source;
      const history = [...(question.repair?.history ?? []), { attempt: 0, issues: [...issues],
        generationResponseId: question.generation.responseId, reviewResponseId: question.generation.reviewResponseId }];
      question.status = 'rejected';
      question.validation = { passed: false, issues };
      question.repair = { attempts: 0, status: completedReview ? 'running' : 'pending', history,
        originalQuestion: original, databaseRevision: revision,
        ...(completedReview ? { candidate: source, generationCallId: completedReview.id } : {}) };
      queued++;
    }));
    await save();
  }
  if (queued) await event(`Проверка оформления: ${queued} заданий временно переведены в черновики и поставлены на исправление с повторной проверкой.`, 'warning');
}
