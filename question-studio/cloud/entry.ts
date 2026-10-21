import { z } from 'zod';
import { config, initializeConfig } from './config.js';
import { event, importState, loadState, restoreLocalState, safeError, save, state } from './store.js';
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
  let stateLoaded = false;
  try {
    runtime = runtimeSchema.parse(JSON.parse(properties.getProperty('STUDIO_RUNTIME_WINDOW') ||
      JSON.stringify({ startedAt, used: 0 })));
    if (startedAt - runtime.startedAt >= 86400000) runtime = { startedAt, used: 0 };
    if (runtime.used + 360000 > config.dailyRuntimeMs) {
      if (properties.getProperty('STUDIO_QUOTA_STATUS_WINDOW') !== String(runtime.startedAt)) {
        loadState();
        publishRuntimeStatus();
        properties.setProperty('STUDIO_QUOTA_STATUS_WINDOW', String(runtime.startedAt));
      }
      return;
    }
    runtime.used += 360000;
    properties.setProperty('STUDIO_RUNTIME_WINDOW', JSON.stringify(runtime));
    runtimeReserved = true;
    loadState();
    stateLoaded = true;
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
    try {
      if (stateLoaded) publishRuntimeStatus();
    } catch (error) {
      properties.setProperty('STUDIO_DIAGNOSTIC_ERROR', safeError(error));
    } finally { lock.releaseLock(); }
  }
}

function publishRuntimeStatus() {
  const properties = PropertiesService.getScriptProperties();
  const runtime = runtimeSchema.parse(JSON.parse(properties.getProperty('STUDIO_RUNTIME_WINDOW') ||
    JSON.stringify({ startedAt: Date.now(), used: 0 })));
  const status = { status: state.status, phase: state.phase, budget: state.budget, totals: state.totals,
    capturedAt: Date.now(), tick: properties.getProperty('STUDIO_LAST_TICK'),
    executionOwner: properties.getProperty('STUDIO_EXECUTION_OWNER'),
    runtime: { ...runtime, limit: config.dailyRuntimeMs, resetsAt: runtime.startedAt + 86400000 },
    error: properties.getProperty('STUDIO_TICK_ERROR') || state.error,
    triggers: ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === 'cloudTick').length };
  requestDatabase(`questionStudioRuntime/${state.runId}`, 'put', status);
  return status;
}

export function cloudStatus() {
  return locked(true, publishRuntimeStatus);
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

export function acceptLocalHandoff() {
  return locked(true, () => {
    const properties = PropertiesService.getScriptProperties();
    const migration = z.object({
      runId: z.literal(state.runId), destination: z.literal('google-apps-script'),
      exportedAt: z.number().int().positive(), checksum: z.string().regex(/^[a-f0-9]{64}$/), payload: z.string().min(1),
    }).parse(requestDatabase(`questionStudioMigrations/${state.runId}`));
    if (properties.getProperty('STUDIO_IMPORTED_CHECKSUM') === migration.checksum) {
      return { status: state.status, budget: state.budget, totals: state.totals };
    }
    if (!localOwnsRun()) throw new Error('Stop cloud execution before importing local state');
    if (Date.now() - migration.exportedAt > 86400000 || migration.exportedAt > Date.now() + 60000) {
      throw new Error('Migration snapshot is not fresh');
    }
    const serialized = Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(migration.payload), 'application/x-gzip'))
      .getDataAsString('UTF-8');
    if (sha256(serialized) !== migration.checksum) throw new Error('Migration checksum mismatch');
    restoreLocalState(JSON.parse(serialized) as unknown);
    event('Актуальные задания, расходы и незавершённые запросы перенесены с ноутбука.', 'success');
    save();
    properties.setProperties({ STUDIO_EXECUTION_OWNER: 'google-apps-script', STUDIO_IMPORTED_CHECKSUM: migration.checksum });
    properties.deleteProperty('STUDIO_TICK_ERROR');
    return { status: state.status, budget: state.budget, totals: state.totals };
  });
}
