import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, updateQuestionAtomically } from './database.js';
import { config } from './config.js';
import { state, event, save } from './store.js';
import { restoreGeneratedQuestion, generatedQuestionContent, languages, type ApiCall, type GeneratedQuestion, type StoredQuestion } from './schema.js';
import { questionPresentationIssues } from './questionPresentation.js';
import { statementPresentation } from './statementPresentation.js';
import type { DataSnapshot } from 'firebase-admin/database';

const recordSchema = z.object({
  generation: z.object({ runId: z.string(), responseId: z.string() }),
  fingerprint: z.string(), topic: z.string(), difficulty: z.string(), correctOption: z.number(),
  diagram: z.unknown().optional(), updatedAt: z.number(),
  translations: z.record(z.string(), z.object({ text: z.string(), options: z.array(z.string()),
    explanation: z.string(), hint: z.string(), imageUrl: z.string().optional() })),
});
const presentationIssue = /Дробь в условии|Степень или индекс|Длинные индексы|Основание логарифма|Корень со сложным|Условие содержит|вариант \d+|Школьные обозначения:/u;
const publishedRecordSchema = recordSchema.extend({
  status: z.literal('published'),
  validation: z.object({ passed: z.literal(true), issues: z.array(z.string()) }),
  generation: recordSchema.shape.generation.extend({ model: z.string().min(1), reviewModel: z.string().optional(),
    reviewResponseId: z.string().min(1), createdAt: z.number().int().positive(), researchResponseId: z.string().optional(),
    referenceSources: z.array(z.object({ url: z.string(), title: z.string() })).optional() }),
});

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

export async function queueQuestionRepair(question: StoredQuestion, issues: string[],
  options: { original?: GeneratedQuestion; completedReview?: ApiCall } = {}): Promise<boolean> {
  const revision = Date.now();
  const source = generatedQuestionContent(question);
  const result = await updateQuestionAtomically(db.ref(`questions/${question.id}`), current => {
    if (!matchesSource(current, source, question) || !current || typeof current !== 'object') return;
    return { ...current, status: 'draft', validation: { passed: false, issues }, updatedAt: revision };
  });
  if (!result.committed) {
    await event(`Задание ${question.id.slice(0, 8)} изменено вне студии или удалено; автоматическая замена пропущена.`, 'warning', question.topic);
    return false;
  }
  const history = [...(question.repair?.history ?? []), { attempt: 0, issues: [...issues],
    generationResponseId: question.generation.responseId, reviewResponseId: question.generation.reviewResponseId }];
  question.status = 'rejected';
  question.validation = { passed: false, issues };
  question.repair = { attempts: 0, status: options.completedReview ? 'running' : 'pending', history,
    originalQuestion: options.original ?? source, databaseRevision: revision,
    ...(options.completedReview ? { candidate: source, generationCallId: options.completedReview.id } : {}) };
  return true;
}

async function recoverPublishedJobs(snapshot: DataSnapshot): Promise<void> {
  let recovered = 0;
  for (const job of state.jobs ?? []) {
    if (!job.batch) continue;
    const call = state.calls.find(item => item.id === job.batch!.generationCallId);
    if (!call?.responseId) continue;
    for (const [index, generated] of job.batch.questions.entries()) {
      const id = createHash('sha256').update(`${state.runId}:${call.responseId}:${index}`).digest('hex').slice(0, 40);
      if (state.questions.some(question => question.id === id)) continue;
      const stored = snapshot.child(id).val() as unknown;
      const parsed = publishedRecordSchema.safeParse(stored);
      if (!parsed.success || parsed.data.generation.runId !== state.runId
        || parsed.data.generation.responseId !== call.responseId || !matchesSource(stored, generated)) continue;
      const source = restoreGeneratedQuestion(generated);
      const translations = { ...source.translations } as StoredQuestion['translations'];
      for (const language of languages) {
        const presentation = statementPresentation(source.translations[language].text);
        translations[language] = { ...source.translations[language],
          imageContainsStatement: presentation.containsStatement, displayText: presentation.displayText,
          ...(parsed.data.translations[language]?.imageUrl ? { imageUrl: parsed.data.translations[language]!.imageUrl } : {}) };
      }
      state.questions.push({ id, topic: source.primaryTopicId, difficulty: source.difficulty,
        correctOption: source.correctOption, diagram: source.diagram, translations, status: 'published',
        fingerprint: parsed.data.fingerprint, validation: parsed.data.validation, generation: parsed.data.generation });
      recovered++;
    }
  }
  if (recovered) await event(`Восстановлены опубликованные задания незавершённых партий: ${recovered}. Повторная генерация не требуется.`, 'info');
}

export async function queuePresentationRepairs(): Promise<void> {
  const snapshot = await db.ref('questions').get();
  await recoverPublishedJobs(snapshot);
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
    .map(question => ({ question, issues: questionPresentationIssues(question.translations, question.diagram) }))
    .map(candidate => recheck.has(candidate.question.id) ? { ...candidate,
      issues: [...candidate.issues, 'Повторно сравните исправленное задание с неизменяемым исходником; при исправлении только оформления математический смысл должен сохраняться.'] } : candidate)
    .filter(candidate => candidate.issues.length);
  let queued = 0;
  for (let offset = 0; offset < candidates.length; offset += config.concurrency) {
    await Promise.all(candidates.slice(offset, offset + config.concurrency).map(async ({ question, issues }) => {
      const completedReview = recheck.has(question.id) ? state.calls.find(call => call.kind === 'repair' && call.responseId === question.generation.responseId) : undefined;
      if (await queueQuestionRepair(question, issues, {
        original: recheck.has(question.id) ? question.repair!.originalQuestion! : undefined, completedReview,
      })) queued++;
    }));
    await save();
  }
  if (queued) await event(`Проверка оформления: ${queued} заданий временно переведены в черновики и поставлены на исправление с повторной проверкой.`, 'warning');
}
