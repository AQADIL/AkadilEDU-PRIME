import { z } from 'zod';
import { config } from './config.js';
import { state, save } from './store.js';
import { CloudYieldError } from './provider.js';
import { languages, type StoredQuestion, type Topic } from '../src/schema.js';

const accountSchema = z.object({ client_email: z.string().email(), private_key: z.string().min(100) });
const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });
const topicSchema = z.object({ name: z.string().min(1), parentId: z.string().nullable().optional(), isLast: z.boolean() }).passthrough();
const objectSchema = z.object({ metadata: z.record(z.string(), z.string()).optional() }).passthrough();

export class FirebaseRequestError extends Error {
  constructor(readonly status: number, operation: string) { super(`${operation}: HTTP ${status}`); }
}

let cachedToken: { value: string; expiresAt: number } | undefined;
const base64Url = (value: string | number[]) => (typeof value === 'string'
  ? Utilities.base64EncodeWebSafe(value) : Utilities.base64EncodeWebSafe(value)).replace(/=+$/, '');

function fetchRemote(url: string, options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions): GoogleAppsScript.URL_Fetch.HTTPResponse {
  let response: GoogleAppsScript.URL_Fetch.HTTPResponse;
  try { response = UrlFetchApp.fetch(url, options); }
  catch { throw new CloudYieldError('Соединение с Firebase временно недоступно; запрос будет восстановлен'); }
  const status = response.getResponseCode();
  if (status === 408 || status === 429 || status >= 500 ||
      (status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded/.test(response.getContentText()))) {
    throw new CloudYieldError(`Firebase временно недоступен: HTTP ${status}`);
  }
  return response;
}

function accessToken(): string {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const encoded = PropertiesService.getScriptProperties().getProperty('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!encoded) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is required');
  const account = accountSchema.parse(JSON.parse(encoded));
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iss: account.client_email,
    scope: `${config.firebaseDatabaseScope} ${config.googleEmailScope} ${config.googleStorageScope}`,
    aud: config.firebaseOAuthUrl, iat: issuedAt, exp: issuedAt + 3600 }));
  const unsigned = `${header}.${payload}`;
  const assertion = `${unsigned}.${base64Url(Utilities.computeRsaSha256Signature(unsigned, account.private_key))}`;
  const response = fetchRemote(config.firebaseOAuthUrl, { method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion } });
  if (response.getResponseCode() !== 200) throw new FirebaseRequestError(response.getResponseCode(), 'Firebase authentication');
  const token = tokenSchema.parse(JSON.parse(response.getContentText()));
  cachedToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
  return token.access_token;
}

function firebaseFetch(url: string, options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {}): GoogleAppsScript.URL_Fetch.HTTPResponse {
  const result = fetchRemote(url, { ...options, muteHttpExceptions: true,
    headers: { ...options.headers, Authorization: `Bearer ${accessToken()}` } });
  if (result.getResponseCode() === 401) cachedToken = undefined;
  return result;
}

export function requestDatabase(path: string, method: GoogleAppsScript.URL_Fetch.HttpMethod = 'get', body?: unknown): unknown {
  if (!/^[A-Za-z0-9_/-]*$/.test(path)) throw new Error('Invalid Firebase path');
  const response = firebaseFetch(`${config.databaseURL.replace(/\/$/, '')}/${path}.json`, {
    method, contentType: 'application/json', ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new FirebaseRequestError(response.getResponseCode(), 'Firebase database');
  }
  return JSON.parse(response.getContentText());
}

export function loadTopics(): void {
  const raw = z.record(z.string(), topicSchema).parse(requestDatabase('topics'));
  const topics: Topic[] = [];
  for (const [id, value] of Object.entries(raw)) {
    if (value.isLast !== true) continue;
    const seen = new Set<string>();
    const names: string[] = [];
    let current: string | null | undefined = id;
    while (current) {
      if (seen.has(current)) throw new Error(`Topic hierarchy cycle: ${id}`);
      seen.add(current);
      const ancestor: z.infer<typeof topicSchema> | undefined = raw[current];
      if (!ancestor) throw new Error(`Missing parent for ${id}`);
      names.unshift(ancestor.name);
      current = ancestor.parentId;
    }
    const eligible = id.toLowerCase() !== 'random';
    const previous = state.topics.find(topic => topic.id === id);
    topics.push({ ...previous, id, name: value.name, path: names, eligible,
      reason: eligible ? null : 'Служебная случайная подборка',
      generated: previous?.generated || 0, target: previous?.target || (eligible ? state.config.perTopic : 0),
      targetPlanned: previous?.targetPlanned || false });
  }
  state.topics = topics.sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), 'kk'));
  save();
}

export function saveQuestionToDatabase(question: StoredQuestion): void {
  const topic = topicSchema.parse(requestDatabase(`topics/${question.topic}`));
  if (topic.isLast !== true) throw new Error(`Topic is no longer a leaf: ${question.topic}`);
  const existing = z.object({ generation: z.object({ runId: z.string() }).optional(), createdAt: z.number().optional() })
    .passthrough().nullable().parse(requestDatabase(`questions/${question.id}`));
  if (existing && existing.generation?.runId !== question.generation.runId) throw new Error('Question ID belongs to another generation run');
  const translations = Object.fromEntries(languages.map(language => {
    const { localImageUrl: _local, displayText, ...content } = question.translations[language];
    return [language, { ...content, text: displayText ?? content.text }];
  }));
  const content = { ...translations.kk, localImageUrl: null, translations,
    topic: question.topic, difficulty: question.difficulty, correctOption: question.correctOption,
    status: question.status === 'published' ? 'published' : 'draft', schemaVersion: 2,
    diagram: question.diagram, validation: question.validation, generation: question.generation,
    fingerprint: question.fingerprint, createdAt: existing?.createdAt || question.generation.createdAt, updatedAt: Date.now() };
  requestDatabase('', 'patch', { [`questions/${question.id}`]: content,
    [`questionsByTopic/${question.topic}/${question.id}`]: true });
}

export function uploadImage(questionId: string, encodedPng: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(questionId)) throw new Error('Invalid question identifier');
  const bytes = Utilities.base64Decode(encodedPng);
  if (bytes.length < 8 || bytes.slice(0, 8).map(value => value & 255).join(',') !== '137,80,78,71,13,10,26,10') {
    throw new Error('Renderer did not return a PNG image');
  }
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(value => (value & 255).toString(16).padStart(2, '0')).join('').slice(0, 16);
  const destination = `questions/${questionId}/${digest}.png`;
  const bucket = encodeURIComponent(config.storageBucket);
  const object = encodeURIComponent(destination);
  const base = config.firebaseStorageApiUrl.replace(/\/$/, '');
  const objectUrl = `${base}/storage/v1/b/${bucket}/o/${object}`;
  let response = firebaseFetch(objectUrl);
  if (response.getResponseCode() === 404) {
    const token = Utilities.getUuid();
    const boundary = `studio_${Utilities.getUuid().replace(/-/g, '')}`;
    const metadata = JSON.stringify({ name: destination, contentType: 'image/png', cacheControl: 'public,max-age=86400',
      metadata: { firebaseStorageDownloadTokens: token } });
    const prefix = Utilities.newBlob(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`).getBytes();
    const suffix = Utilities.newBlob(`\r\n--${boundary}--\r\n`).getBytes();
    response = firebaseFetch(`${base}/upload/storage/v1/b/${bucket}/o?uploadType=multipart&ifGenerationMatch=0`, {
      method: 'post', contentType: `multipart/related; boundary=${boundary}`, payload: prefix.concat(bytes, suffix),
    });
    if (response.getResponseCode() === 409 || response.getResponseCode() === 412) response = firebaseFetch(objectUrl);
  }
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new FirebaseRequestError(response.getResponseCode(), 'Firebase image upload');
  }
  let metadata = objectSchema.parse(JSON.parse(response.getContentText()));
  let token = metadata.metadata?.firebaseStorageDownloadTokens?.split(',')[0];
  if (!token) {
    token = Utilities.getUuid();
    response = firebaseFetch(objectUrl, { method: 'patch', contentType: 'application/json',
      payload: JSON.stringify({ metadata: { ...metadata.metadata, firebaseStorageDownloadTokens: token } }) });
    if (response.getResponseCode() !== 200) throw new FirebaseRequestError(response.getResponseCode(), 'Firebase image metadata');
    metadata = objectSchema.parse(JSON.parse(response.getContentText()));
    token = metadata.metadata?.firebaseStorageDownloadTokens?.split(',')[0];
    if (!token) throw new Error('Firebase image download token is missing');
  }
  return `${config.firebaseStorageDownloadUrl.replace(/\/$/, '')}/b/${bucket}/o/${object}?alt=media&token=${encodeURIComponent(token)}`;
}
