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
import { publicState } from './public-state.js';

if (config.executionOwner === 'google-apps-script') {
  await releaseLock();
  throw new Error('Generation has migrated to Google Apps Script. Pause its trigger and restore the authoritative cloud state before enabling local execution.');
}
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
    json(response, 200, publicState(state, config)); return;
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
      if (state.pendingBatch || state.generationCallId || state.jobs?.length) throw new Error('Сначала продолжите незавершённые партии');
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
