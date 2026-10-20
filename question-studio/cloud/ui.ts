import { publicState } from '../src/public-state.js';
import { config } from './config.js';
import { safeError, state } from './store.js';
import { z } from 'zod';

const runtimeSchema = z.object({ startedAt: z.number().finite().nonnegative(), used: z.number().finite().nonnegative() });

export function publicCloudState() {
  const mediaOrigin = /^https:\/\/[^/?#]+/.exec(config.firebaseStorageDownloadUrl)?.[0];
  if (!mediaOrigin) throw new Error('Firebase image endpoint must use HTTPS');
  const properties = PropertiesService.getScriptProperties();
  const lastTick = Number(properties.getProperty('STUDIO_LAST_TICK'));
  const tickError = properties.getProperty('STUDIO_TICK_ERROR');
  let runtime: z.infer<typeof runtimeSchema> | null = null;
  let cloudError = tickError ? safeError(new Error(tickError)) : null;
  const encodedRuntime = properties.getProperty('STUDIO_RUNTIME_WINDOW');
  if (encodedRuntime) {
    try { runtime = runtimeSchema.parse(JSON.parse(encodedRuntime)); }
    catch { cloudError = 'Не удалось прочитать учёт времени облачного заполнителя.'; }
  }
  const windowActive = runtime !== null && Date.now() < runtime.startedAt + 86400000;
  const waitingUntil = runtime && windowActive && runtime.used + 360000 > config.dailyRuntimeMs
    ? runtime.startedAt + 86400000 : null;
  const projected = publicState(state, config);
  return JSON.parse(JSON.stringify({
    ...projected,
    phase: state.status === 'running' && waitingUntil
      ? `Ожидание бесплатной дневной квоты до ${new Date(waitingUntil).toISOString()}` : projected.phase,
    cloudError,
    cloud: {
      lastTickAt: Number.isFinite(lastTick) && lastTick > 0 ? lastTick : null,
      runtime: runtime ? { ...runtime, limit: config.dailyRuntimeMs } : null,
      waitingUntil,
    },
    mediaOrigins: [mediaOrigin],
  })) as Record<string, unknown>;
}
