import { z } from 'zod';
import { config, initializeConfig } from './config.js';
import { event, importState, loadState, safeError, save, state } from './store.js';
import { runWorkerStep } from './worker.js';
import { request } from './api.js';
import { loadTopics, requestDatabase } from './database.js';
import { sha256 } from './provider.js';

function localOwnsRun() {
  return PropertiesService.getScriptProperties().getProperty('STUDIO_EXECUTION_OWNER') === 'local';
}

function owner(interactive: boolean) {
  const effective = Session.getEffectiveUser().getEmail().toLowerCase();
  const active = Session.getActiveUser().getEmail().toLowerCase();
  if (effective !== config.ownerEmail || (interactive && active !== config.ownerEmail)) throw new Error('Доступ только владельцу студии');
}

function locked<T>(interactive: boolean, operation: () => T): T {
  initializeConfig();
  owner(interactive);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Заполнитель сохраняет текущий шаг. Повторите через несколько секунд.');
  try { loadState(); return operation(); }
  finally { lock.releaseLock(); }
}

export function doGet() {
  initializeConfig(); owner(true);
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('AkadilEDU · Question Studio')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

export function studioRequest(path: unknown, body: unknown) {
  return locked(true, () => {
    if (localOwnsRun() && path !== '/api/state') throw new Error('Генерация перенесена на ноутбук. Облачное состояние больше не является актуальным.');
    return request(path, body);
  });
}

export function bootstrapCloud() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Настройка уже выполняется');
  try {
    const properties = PropertiesService.getScriptProperties();
    if (properties.getProperty('STUDIO_STATE_SLOTS')) throw new Error('Облачная студия уже настроена. Импорт повторно запрещён.');
    const encoded = HtmlService.createHtmlOutputFromFile('Bootstrap').getContent().trim();
    const decoded: unknown = JSON.parse(Utilities.newBlob(Utilities.base64Decode(encoded)).getDataAsString('UTF-8'));
    const payload = z.object({ properties: z.record(z.string(), z.string()), state: z.unknown() }).parse(decoded);
    if (Session.getActiveUser().getEmail().toLowerCase() !== payload.properties.STUDIO_OWNER_EMAIL?.toLowerCase()) {
      throw new Error('Настройку должен выполнить владелец');
    }
    properties.setProperties(payload.properties);
    initializeConfig(); owner(true);
    importState(payload.state);
    loadTopics();
    event('Состояние и расходы перенесены. Облачная студия готова к запуску.', 'success');
    save();
  } finally { lock.releaseLock(); }
}

export function activateCloud() {
  return locked(true, () => {
    if (localOwnsRun()) throw new Error('Для возврата в облако сначала перенесите актуальное состояние с ноутбука');
    if (state.calls.some(call => call.status === 'uncertain' || call.status === 'reserved')) throw new Error('Сначала требуется сверка неопределённых API-запросов');
    if (state.budget.spent + state.budget.reserved >= state.budget.limit) throw new Error('Лимит API исчерпан');
    if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === 'cloudTick')) {
      ScriptApp.newTrigger('cloudTick').timeBased().everyMinutes(config.tickMinutes).create();
    }
    state.status = 'running'; state.error = null;
    event('Заполнитель запущен в Google. Лимит API и текущий расход сохранены.', 'success');
    save();
    return { runId: state.runId, budget: state.budget, status: state.status };
  });
}

const runtimeSchema = z.object({ startedAt: z.number().nonnegative(), used: z.number().nonnegative() });

export function cloudTick() {
  const startedAt = Date.now();
  initializeConfig(); owner(false);
  if (localOwnsRun()) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const properties = PropertiesService.getScriptProperties();
  let runtime: z.infer<typeof runtimeSchema> | undefined;
  let runtimeReserved = false;
  try {
    runtime = runtimeSchema.parse(JSON.parse(properties.getProperty('STUDIO_RUNTIME_WINDOW') ||
      JSON.stringify({ startedAt, used: 0 })));
    if (startedAt - runtime.startedAt >= 86400000) runtime = { startedAt, used: 0 };
    if (runtime.used + 360000 > config.dailyRuntimeMs) return;
    runtime.used += 360000;
    properties.setProperty('STUDIO_RUNTIME_WINDOW', JSON.stringify(runtime));
    runtimeReserved = true;
    loadState();
    if (state.status !== 'running') return;
    properties.setProperty('STUDIO_LAST_TICK', String(startedAt));
    runWorkerStep();
    save();
    if (String(state.status) === 'error') throw new Error(state.error || 'Cloud worker failed');
    properties.deleteProperty('STUDIO_TICK_ERROR');
  } catch (error) {
    properties.setProperty('STUDIO_TICK_ERROR', safeError(error));
    throw new Error(safeError(error));
  } finally {
    if (runtime && runtimeReserved) {
      runtime.used = runtime.used - 360000 + (Date.now() - startedAt);
      properties.setProperty('STUDIO_RUNTIME_WINDOW', JSON.stringify(runtime));
    }
    lock.releaseLock();
  }
}

export function cloudStatus() {
  return locked(true, () => ({ status: state.status, phase: state.phase, budget: state.budget, totals: state.totals,
    tick: PropertiesService.getScriptProperties().getProperty('STUDIO_LAST_TICK'),
    error: PropertiesService.getScriptProperties().getProperty('STUDIO_TICK_ERROR') || state.error,
    triggers: ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === 'cloudTick').length }));
}

export function handoffToLocal() {
  return locked(true, () => {
    state.status = 'paused';
    event('Генерация передана локальной студии. Облачный таймер остановлен.');
    save();
    PropertiesService.getScriptProperties().setProperty('STUDIO_EXECUTION_OWNER', 'local');
    for (const trigger of ScriptApp.getProjectTriggers()) {
      if (trigger.getHandlerFunction() === 'cloudTick') ScriptApp.deleteTrigger(trigger);
    }
    const serialized = JSON.stringify(state);
    const payload = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(serialized, 'application/json')).getBytes());
    requestDatabase(`questionStudioMigrations/${state.runId}`, 'put', {
      runId: state.runId, destination: 'local', exportedAt: Date.now(), checksum: sha256(serialized), payload,
    });
    return { runId: state.runId, budget: state.budget, totals: state.totals, status: state.status };
  });
}
