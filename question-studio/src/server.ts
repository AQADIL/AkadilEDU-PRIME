import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { config, studioRoot } from './config.js';
import { state, event, save, safeError, releaseLock } from './store.js';
import { loadTopics } from './database.js';
import { startWorker, pauseWorker, waitForWorker, publishQuestions, rerenderQuestions, startSchema } from './worker.js';
import { closeRenderer } from './render.js';
import type { ApiCall } from './schema.js';

const csrfToken = randomBytes(32).toString('hex');
let mutating = false;
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function bodyOf(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > 1000000) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}
function publicState() {
  const callsById = new Map(state.calls.map(call => [call.id, call]));
  const callsByResponse = new Map(state.calls.filter(call => call.responseId).map(call => [call.responseId!, call]));
  const sampledCalls = new Map<string, number>();
  let acceptedInSample = 0;
  let sampledBatches = 0;
  let incompleteAccounting = false;
  function lineage(call: ApiCall): ApiCall[] | null {
    const collected = new Map<string, ApiCall>();
    const queue = [call];
    while (queue.length) {
      const current = queue.pop()!;
      if (collected.has(current.id)) continue;
      collected.set(current.id, current);
      for (const id of [current.retryOf, current.retryCallId]) {
        if (!id) continue;
        const related = callsById.get(id);
        if (!related) return null;
        if (!collected.has(id)) queue.push(related);
      }
    }
    return [...collected.values()];
  }
  for (const generation of state.calls.filter(call => call.kind === 'generation' && call.model === config.model
    && call.status === 'settled' && !call.retryCallId)) {
    const chain = lineage(generation);
    if (!chain) { incompleteAccounting = true; continue; }
    if (chain.some(call => call.id === state.pendingBatch?.generationCallId || call.id === state.generationCallId)) continue;
    const questions = generation.responseId ? state.questions.filter(question => question.generation.responseId === generation.responseId
      || question.repair?.history.some(entry => entry.generationResponseId === generation.responseId)) : [];
    if (questions.some(question => question.repair?.status === 'pending' || question.repair?.status === 'running')) continue;
    if (questions.some(question => question.generation.reviewModel !== config.reviewModel)) continue;
    if (!questions.length && !generation.terminalReason) { incompleteAccounting = true; continue; }
    const references = new Set<string>();
    let missingReference = false;
    for (const question of questions) {
      references.add(question.generation.responseId);
      references.add(question.generation.reviewResponseId);
      for (const entry of question.repair?.history ?? []) {
        if (entry.generationResponseId) references.add(entry.generationResponseId);
        if (entry.reviewResponseId) references.add(entry.reviewResponseId);
      }
      for (const id of [question.repair?.generationCallId, question.repair?.reviewCallId]) {
        if (!id) continue;
        const call = callsById.get(id);
        if (call) chain.push(call); else missingReference = true;
      }
    }
    for (const responseId of references) {
      const call = callsByResponse.get(responseId);
      if (call) chain.push(call); else missingReference = true;
    }
    const relatedCalls = new Map<string, ApiCall>();
    while (chain.length) {
      const call = chain.pop()!;
      if (relatedCalls.has(call.id)) continue;
      const related = lineage(call);
      if (!related) { missingReference = true; continue; }
      for (const item of related) relatedCalls.set(item.id, item);
      for (const item of related) {
        if (!item.researchResponseId) continue;
        const research = callsByResponse.get(item.researchResponseId);
        if (research) chain.push(research); else missingReference = true;
      }
    }
    const calls = [...relatedCalls.values()];
    if (missingReference) { incompleteAccounting = true; continue; }
    if (calls.some(call => call.status !== 'settled')) continue;
    if (calls.some(call => call.model !== (call.kind === 'review' ? config.reviewModel : config.model))) continue;
    for (const call of calls) sampledCalls.set(call.id, call.cost);
    acceptedInSample += questions.filter(question => question.validation.passed).length;
    sampledBatches += 1;
  }
  const sampleCost = [...sampledCalls.values()].reduce((sum, cost) => sum + cost, 0);
  const costPerAccepted = acceptedInSample && !incompleteAccounting ? sampleCost / acceptedInSample : null;
  const remainingTarget = state.topics.filter(t => t.eligible).reduce((sum, t) => sum + Math.max(0, t.target - t.generated), 0);
  return {
    ...state, calls: undefined, sourceText: undefined, pendingBatch: undefined, generationCallId: undefined,
    model: config.model,
    reviewModel: config.reviewModel,
    autoPublish: config.autoPublish,
    pricing: { generation: config.prices, review: config.reviewPrices },
    repairTotals: {
      queued: state.questions.filter(question => question.repair?.status === 'pending' || question.repair?.status === 'running').length,
      completed: state.questions.filter(question => question.repair?.status === 'completed').length,
      exhausted: state.questions.filter(question => question.repair?.status === 'exhausted').length,
    },
    forecast: {
      target: state.topics.filter(t => t.eligible).reduce((sum, t) => sum + t.target, 0),
      costPerAccepted,
      unavailableReason: incompleteAccounting ? 'accounting' : null,
      sampleAccepted: acceptedInSample,
      sampleBatches: sampledBatches,
      estimatedTotal: costPerAccepted === null ? null : state.budget.spent + costPerAccepted * remainingTarget,
    },
  };
}
async function handle(request: IncomingMessage, response: ServerResponse) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://firebasestorage.googleapis.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (request.headers.host !== new URL(config.origin).host
    || (request.headers.origin && request.headers.origin !== config.origin)
    || request.headers['sec-fetch-site'] === 'cross-site') {
    json(response, 403, { error: 'Only local same-origin access is allowed' }); return;
  }
  const url = new URL(request.url || '/', config.origin);
  if (request.method === 'GET' && url.pathname === '/api/session') {
    json(response, 200, { csrfToken }); return;
  }
  if (request.method === 'GET' && url.pathname === '/api/state') {
    json(response, 200, publicState()); return;
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
    const token = request.headers['x-studio-token'];
    if (typeof token !== 'string' || token.length !== csrfToken.length
      || !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))) {
      json(response, 403, { error: 'Invalid session token; reload the page' }); return;
    }
    const body = await bodyOf(request);
    if (mutating) { json(response, 409, { error: 'Предыдущее действие ещё выполняется' }); return; }
    mutating = true;
    try {
    if (url.pathname === '/api/start') {
      if (state.status === 'running') throw new Error('Генерация уже выполняется');
      if (state.pendingBatch || state.generationCallId) throw new Error('Сначала продолжите незавершённую партию');
      const input = startSchema.parse(body);
      if (input.mode === 'parse' && !input.sourceText?.trim()) throw new Error('Добавьте текст для разбора');
      const selected = input.topicIds || [];
      if (selected.some(id => !state.topics.some(t => t.id === id && t.eligible))) throw new Error('Выбрана недопустимая тема');
      state.status = 'running';
      state.config.perTopic = input.perTopic;
      state.config.batchSize = input.batchSize;
      state.mode = input.mode;
      state.sourceText = input.sourceText || '';
      state.sourceOffset = 0;
      state.selectedTopicIds = selected;
      await save();
      startWorker();
    } else if (url.pathname === '/api/pause') {
      z.strictObject({}).parse(body);
      await pauseWorker();
    } else if (url.pathname === '/api/resume') {
      if (state.status === 'running') throw new Error('Генерация уже выполняется');
      const input = z.strictObject({ topicIds: z.array(z.string().min(1).max(200)).max(1000).optional() }).parse(body);
      if (input.topicIds) {
        if (input.topicIds.some(id => !state.topics.some(t => t.id === id && t.eligible))) throw new Error('Выбрана недопустимая тема');
        state.selectedTopicIds = [...new Set(input.topicIds)];
        await save();
      }
      startWorker();
    } else if (url.pathname === '/api/publish') {
      const input = z.strictObject({ ids: z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1).max(500) }).parse(body);
      await publishQuestions(input.ids);
    } else if (url.pathname === '/api/rerender') {
      const input = z.strictObject({ ids: z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1).max(50) }).parse(body);
      await rerenderQuestions(input.ids);
    } else {
      json(response, 404, { error: 'Unknown action' }); return;
    }
      json(response, 200, { ok: true }); return;
    } finally {
      mutating = false;
    }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    json(response, 405, { error: 'Method not allowed' }); return;
  }
  let root = path.join(studioRoot, 'public');
  let relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  if (url.pathname.startsWith('/vendor/katex/')) {
    root = path.join(studioRoot, 'node_modules/katex/dist');
    relative = decodeURIComponent(url.pathname.slice('/vendor/katex/'.length));
  } else if (url.pathname.startsWith('/media/')) {
    root = path.join(config.dataDir, 'media');
    relative = decodeURIComponent(url.pathname.slice('/media/'.length));
  }
  const filename = path.resolve(root, relative);
  const withinRoot = path.relative(root, filename);
  if (!withinRoot || withinRoot.startsWith('..') || path.isAbsolute(withinRoot) || relative.split(/[\\/]/).some(p => p.startsWith('.'))) {
    json(response, 404, { error: 'Not found' }); return;
  }
  const info = await stat(filename).catch(() => null);
  const type = contentTypes[path.extname(filename)];
  if (!info?.isFile() || !type) { json(response, 404, { error: 'Not found' }); return; }
  response.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(filename);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

await loadTopics();
await event(`Подключено тем: ${state.totals.eligible}. Создание: ${config.model}. Проверка: ${config.reviewModel}. Бюджет: $${state.budget.limit}.`);
const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    if (!response.headersSent) json(response, 400, { error: safeError(error) });
    else response.destroy();
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.on('error', error => {
  process.stderr.write(`${safeError(error)}\n`);
  releaseLock().finally(() => process.exit(1)).catch(() => process.exit(1));
});
server.listen(config.port, config.host, () => {
  process.stdout.write(`AkadilEDU Question Studio: ${config.origin}\n`);
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await pauseWorker();
  await waitForWorker();
  await save();
  await closeRenderer();
  await releaseLock();
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => { shutdown().catch(error => { process.stderr.write(safeError(error)); process.exit(1); }); });
process.on('SIGTERM', () => { shutdown().catch(error => { process.stderr.write(safeError(error)); process.exit(1); }); });
