import { z } from 'zod';
import { config } from './config.js';
import { generatedQuestionSchema, type StudioState } from '../src/schema.js';

const accounting = z.object({
  version: z.literal(1), runId: z.string().min(1),
  budget: z.object({ limit: z.number().positive().max(50), spent: z.number().nonnegative(), reserved: z.number().nonnegative() }),
  calls: z.array(z.object({
    id: z.string().min(1), model: z.string().min(1), kind: z.enum(['generation', 'review', 'repair', 'research']),
    status: z.enum(['reserved', 'pending', 'settled', 'uncertain']), cost: z.number().nonnegative(), reserved: z.number().nonnegative(),
    prices: z.object({ input: z.number().positive(), cachedInput: z.number().nonnegative(), cacheWrite: z.number().positive(),
      output: z.number().positive(), webSearch: z.number().positive().optional() }),
  })),
  questions: z.array(z.object({ id: z.string(), topic: z.string(), validation: z.object({ passed: z.boolean(), issues: z.array(z.string()) }) })),
  topics: z.array(z.object({ id: z.string(), eligible: z.boolean(), target: z.number().nonnegative() })),
  events: z.array(z.object({ id: z.string(), time: z.number(), message: z.string(), level: z.string() })),
  status: z.enum(['idle', 'running', 'paused', 'error', 'budget_exhausted', 'completed']),
  config: z.object({ perTopic: z.number().positive(), batchSize: z.number().int().positive(),
    difficultyWeights: z.object({ easy: z.number().positive(), medium: z.number().positive(), hard: z.number().positive() }) }),
  selectedTopicIds: z.array(z.string()), sourceText: z.string(), sourceOffset: z.number().nonnegative(),
  mode: z.enum(['generate', 'parse']),
});

export let state: StudioState;
let slots: string[] = [];
let activeSlot = 0;
let lastSerialized = '';

function serialize() {
  return Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(state), 'application/json')).getBytes());
}

function validateState(value: unknown): StudioState {
  accounting.parse(value);
  const saved = value as StudioState;
  if (new Set(saved.calls.map(call => call.id)).size !== saved.calls.length) throw new Error('Duplicate accounting entries');
  for (const question of saved.questions) {
    if (question.diagram) {
      question.diagram.arcs ??= [];
      question.diagram.angles ??= [];
    }
    generatedQuestionSchema.parse({
    primaryTopicId: question.topic, difficulty: question.difficulty, correctOption: question.correctOption,
    diagram: question.diagram, translations: Object.fromEntries(Object.entries(question.translations).map(([language, text]) =>
      [language, { text: text.text, options: text.options, explanation: text.explanation, hint: text.hint }])) });
  }
  for (const call of saved.calls) {
    if (call.kind === 'research' && (!call.prices.webSearch || !call.webSearchMaxCalls)) throw new Error('Research accounting is incomplete');
    if (call.status === 'pending' && !call.responseId) throw new Error('Pending response identifier is missing');
    if (call.status === 'reserved') call.status = 'uncertain';
  }
  const spent = saved.calls.reduce((sum, call) => sum + call.cost, 0);
  const reserved = saved.calls.filter(call => call.status !== 'settled').reduce((sum, call) => sum + call.reserved, 0);
  if (Math.abs(spent - saved.budget.spent) > 1e-8 || Math.abs(reserved - saved.budget.reserved) > 1e-8) {
    throw new Error('Budget ledger does not match its call history');
  }
  return saved;
}

export function importState(value: unknown) {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('STUDIO_STATE_SLOTS')) throw new Error('Cloud state already exists; replacing its budget is forbidden');
  state = validateState(value);
  if (state.status === 'running') throw new Error('Pause the local worker before migration');
  if (state.calls.some(call => call.status === 'uncertain')) throw new Error('Reconcile uncertain API calls before migration');
  state.budget.limit = Math.min(state.budget.limit, config.budget);
  state.status = 'paused';
  const folder = DriveApp.createFolder('AkadilEDU Question Studio — state');
  const serialized = serialize();
  lastSerialized = serialized;
  slots = [folder.createFile('state-a.json', serialized, MimeType.PLAIN_TEXT).getId(),
    folder.createFile('state-b.json', serialized, MimeType.PLAIN_TEXT).getId()];
  activeSlot = 0;
  properties.setProperties({ STUDIO_STATE_SLOTS: JSON.stringify(slots), STUDIO_STATE_ACTIVE: '0', STUDIO_STATE_FOLDER: folder.getId() });
}

export function restoreLocalState(value: unknown) {
  const incoming = validateState(value);
  if (incoming.runId !== state.runId || incoming.status !== 'paused') throw new Error('Migration must contain the same paused run');
  if (incoming.calls.some(call => call.status === 'uncertain')) throw new Error('Uncertain charges cannot be migrated');
  if (incoming.budget.spent < state.budget.spent || incoming.budget.limit > state.budget.limit) {
    throw new Error('Migration cannot reset spend or increase the budget');
  }
  const calls = new Map(incoming.calls.map(call => [call.id, call]));
  for (const previous of state.calls) {
    const current = calls.get(previous.id);
    if (!current || current.kind !== previous.kind || current.model !== previous.model
      || (previous.responseId && current.responseId !== previous.responseId)
      || current.reserved !== previous.reserved || current.cost < previous.cost
      || JSON.stringify(current.prices) !== JSON.stringify(previous.prices)
      || (previous.status === 'settled' && (current.status !== 'settled' || current.cost !== previous.cost))) {
      throw new Error('Migration would change or discard existing API accounting');
    }
  }
  if (state.questions.some(previous => !incoming.questions.some(question => question.id === previous.id))) {
    throw new Error('Migration would discard existing questions');
  }
  state = incoming;
  state.budget.limit = Math.min(state.budget.limit, config.budget);
  state.error = null;
  save();
}

export function loadState() {
  const properties = PropertiesService.getScriptProperties();
  slots = z.array(z.string().min(1)).length(2).parse(JSON.parse(properties.getProperty('STUDIO_STATE_SLOTS') || 'null'));
  activeSlot = z.union([z.literal(0), z.literal(1)]).parse(Number(properties.getProperty('STUDIO_STATE_ACTIVE')));
  const compressed = DriveApp.getFileById(slots[activeSlot]!).getBlob().getDataAsString('UTF-8');
  lastSerialized = compressed;
  state = validateState(JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(compressed), 'application/x-gzip')).getDataAsString('UTF-8')) as unknown);
  state.budget.limit = Math.min(state.budget.limit, config.budget);
  state.model = config.model;
}

export function save() {
  state.budget.spent = state.calls.reduce((sum, call) => sum + call.cost, 0);
  state.budget.reserved = state.calls.filter(call => call.status !== 'settled').reduce((sum, call) => sum + call.reserved, 0);
  state.totals = { eligible: state.topics.filter(topic => topic.eligible).length,
    generated: state.questions.filter(question => question.validation.passed).length,
    published: state.questions.filter(question => question.status === 'published').length,
    rejected: state.questions.filter(question => !question.validation.passed).length };
  for (const topic of state.topics) {
    topic.generated = state.questions.filter(question => question.topic === topic.id && question.validation.passed).length;
    if (!topic.targetPlanned) topic.target = topic.eligible ? state.config.perTopic : 0;
  }
  const next = 1 - activeSlot;
  const serialized = serialize();
  if (lastSerialized === serialized) return;
  DriveApp.getFileById(slots[next]!).setContent(serialized);
  PropertiesService.getScriptProperties().setProperty('STUDIO_STATE_ACTIVE', String(next));
  activeSlot = next;
  lastSerialized = serialized;
}

export function event(message: string, level = 'info', topicId?: string) {
  state.events.push({ id: Utilities.getUuid(), time: Date.now(), level, message, ...(topicId ? { topicId } : {}) });
  if (state.events.length > 1500) state.events.splice(0, state.events.length - 1500);
  state.phase = message;
}
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
  return message.replaceAll(config.apiKey, '[redacted]').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 700);
}
