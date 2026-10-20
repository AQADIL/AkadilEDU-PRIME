import { readFile } from 'node:fs/promises';
import { cert, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getDownloadURL, getStorage } from 'firebase-admin/storage';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { state, save } from './store.js';
import { languages, type StoredQuestion, type Topic } from './schema.js';

const account = JSON.parse(await readFile(config.credentials, 'utf8')) as object;
const app = initializeApp({ credential: cert(account), databaseURL: config.databaseURL, storageBucket: config.storageBucket }, 'question-studio');
export const db = getDatabase(app);
const topicRecord = z.object({ name: z.string().min(1), parentId: z.string().nullable().optional(), isLast: z.boolean() }).passthrough();

export async function loadTopics() {
  const snapshot = await db.ref('topics').get();
  const raw = z.record(z.string(), topicRecord).parse(snapshot.val());
  const topics: Topic[] = [];
  for (const [id, value] of Object.entries(raw)) {
    if (value.isLast !== true) continue;
    const seen = new Set<string>();
    const names: string[] = [];
    let current: string | null | undefined = id;
    while (current) {
      if (seen.has(current)) throw new Error(`Topic hierarchy cycle: ${id}`);
      seen.add(current);
      const ancestor: z.infer<typeof topicRecord> | undefined = raw[current];
      if (!ancestor) throw new Error(`Missing parent for ${id}`);
      names.unshift(ancestor.name);
      current = ancestor.parentId;
    }
    const eligible = id.toLowerCase() !== 'random';
    const previous = state.topics.find(t => t.id === id);
    topics.push({ ...previous, id, name: value.name, path: names, eligible,
      reason: eligible ? null : 'Служебная случайная подборка',
      generated: previous?.generated || 0, target: previous?.target || (eligible ? state.config.perTopic : 0),
      targetPlanned: previous?.targetPlanned || false,
    });
  }
  state.topics = topics.sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), 'kk'));
  await save();
}

export async function saveQuestionToDatabase(question: StoredQuestion) {
  const topic = await db.ref(`topics/${question.topic}`).get();
  if (topic.val()?.isLast !== true) throw new Error(`Topic is no longer a leaf: ${question.topic}`);
  const reference = db.ref(`questions/${question.id}`);
  const existing = await reference.get();
  if (existing.exists() && existing.val()?.generation?.runId !== question.generation.runId) {
    throw new Error('Question ID belongs to a different generation run');
  }
  const translations = Object.fromEntries(languages.map(lang => {
    const { localImageUrl: _local, ...content } = question.translations[lang];
    return [lang, content];
  }));
  await reference.update({
    ...question.translations.kk, localImageUrl: null, translations,
    topic: question.topic, difficulty: question.difficulty, correctOption: question.correctOption,
    status: question.status === 'published' ? 'published' : 'draft',
    schemaVersion: 2, diagram: question.diagram, validation: question.validation,
    generation: question.generation, fingerprint: question.fingerprint,
    createdAt: existing.val()?.createdAt || question.generation.createdAt, updatedAt: Date.now(),
  });
  await db.ref(`questionsByTopic/${question.topic}/${question.id}`).set(true);
}

export async function uploadImage(questionId: string, filename: string): Promise<string> {
  const digest = createHash('sha256').update(await readFile(filename)).digest('hex').slice(0, 16);
  const destination = `questions/${questionId}/${digest}.png`;
  const bucket = getStorage(app).bucket();
  const existing = bucket.file(destination);
  if ((await existing.exists())[0]) return getDownloadURL(existing);
  const [file] = await bucket.upload(filename, {
    destination, metadata: { contentType: 'image/png', cacheControl: 'public,max-age=86400',
      metadata: { firebaseStorageDownloadTokens: randomUUID() } },
  });
  return getDownloadURL(file);
}
