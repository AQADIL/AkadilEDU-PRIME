import { z } from 'zod';
import { event, save, state } from './store.js';
import { publishQuestions, rerenderQuestions, startSchema } from './worker.js';
import { publicCloudState } from './ui.js';

const topicIdsSchema = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).max(500);
const questionIdSchema = z.string().regex(/^[a-f0-9]{40}$/);
const pathSchema = z.enum(['/api/state', '/api/start', '/api/pause', '/api/resume', '/api/publish', '/api/rerender']);

function validatedTopics(ids: string[]): string[] {
  if (ids.some(id => !state.topics.some(topic => topic.id === id && topic.eligible))) {
    throw new Error('Выбрана недопустимая тема');
  }
  return [...new Set(ids)];
}

function start() {
  state.status = 'running';
  state.error = null;
  event('Облачный заполнитель продолжит работу по расписанию. Браузер можно закрыть.');
}

export function request(rawPath: unknown, body: unknown): Record<string, unknown> {
  const path = pathSchema.parse(rawPath);
  if (path === '/api/state') {
    z.null().parse(body);
    return publicCloudState();
  }
  if (JSON.stringify(body)?.length > 1000000) throw new Error('Слишком большой запрос');
  if (path === '/api/start') {
    if (state.status === 'running') throw new Error('Генерация уже выполняется');
    if (state.pendingBatch || state.generationCallId) throw new Error('Сначала продолжите незавершённую партию');
    const input = startSchema.parse(body);
    if (input.mode === 'parse' && !input.sourceText?.trim()) throw new Error('Добавьте текст для разбора');
    const selected = validatedTopics(input.topicIds || []);
    state.config.perTopic = input.perTopic;
    state.config.batchSize = input.batchSize;
    state.mode = input.mode;
    state.sourceText = input.sourceText || '';
    state.sourceOffset = 0;
    state.selectedTopicIds = selected;
    start();
  } else if (path === '/api/pause') {
    z.strictObject({}).parse(body);
    state.status = 'paused';
    event('Пауза. Текущие запросы, результаты и учёт расходов сохранены.');
  } else if (path === '/api/resume') {
    if (state.status === 'running') throw new Error('Генерация уже выполняется');
    const input = z.strictObject({ topicIds: topicIdsSchema.optional() }).parse(body);
    if (input.topicIds) state.selectedTopicIds = validatedTopics(input.topicIds);
    start();
  } else if (path === '/api/publish') {
    const input = z.strictObject({ ids: z.array(questionIdSchema).length(1) }).parse(body);
    publishQuestions([...new Set(input.ids)]);
  } else if (path === '/api/rerender') {
    const input = z.strictObject({ ids: z.array(questionIdSchema).length(1) }).parse(body);
    rerenderQuestions([...new Set(input.ids)]);
  }
  save();
  return { ok: true };
}
