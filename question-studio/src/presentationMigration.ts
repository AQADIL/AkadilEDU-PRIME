import { db } from './database.js';
import { state, event } from './store.js';
import { languages } from './schema.js';
import { questionPresentationIssues } from './questionPresentation.js';

export async function queuePresentationRepairs(): Promise<void> {
  const candidates = state.questions.filter(question => question.validation.passed)
    .map(question => ({ question, issues: questionPresentationIssues(question.translations) }))
    .filter(candidate => candidate.issues.length);
  if (!candidates.length) return;
  const snapshot = await db.ref('questions').get();
  const updates: Record<string, unknown> = {};
  const queued: typeof candidates = [];
  for (const candidate of candidates) {
    const { question, issues } = candidate;
    const existing = snapshot.child(question.id);
    const matches = existing.child('generation/runId').val() === question.generation.runId
      && existing.child('fingerprint').val() === question.fingerprint
      && languages.every(language => {
        const source = question.translations[language];
        const translation = existing.child(`translations/${language}`);
        return translation.child('text').val() === (source.displayText ?? source.text)
          && JSON.stringify(translation.child('options').val()) === JSON.stringify(source.options)
          && translation.child('explanation').val() === source.explanation
          && translation.child('hint').val() === source.hint;
      });
    if (!matches) {
      await event(`Задание ${question.id.slice(0, 8)} изменено вне студии или удалено; автоматическая замена пропущена.`, 'warning', question.topic);
      continue;
    }
    updates[`questions/${question.id}/status`] = 'draft';
    updates[`questions/${question.id}/validation`] = { passed: false, issues };
    updates[`questions/${question.id}/updatedAt`] = Date.now();
    queued.push(candidate);
  }
  if (!queued.length) return;
  await db.ref().update(updates);
  for (const { question, issues } of queued) {
    question.status = 'rejected';
    question.validation = { passed: false, issues };
    question.repair = { attempts: 0, status: 'pending', history: [
      ...(question.repair?.history ?? []),
      { attempt: 0, issues: [...issues], generationResponseId: question.generation.responseId,
        reviewResponseId: question.generation.reviewResponseId },
    ] };
  }
  await event(`Проверка оформления: ${queued.length} заданий временно переведены в черновики и поставлены на исправление с повторной проверкой.`, 'warning');
}
