import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

export const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: process.env.AGENT_ENV_FILE ?? path.join(agentRoot, '.env.agent'), quiet: true });
const env = z.object({
  FIREBASE_DATABASE_URL: z.url(), FIREBASE_STORAGE_BUCKET: z.string().min(1),
  GOOGLE_APPLICATION_CREDENTIALS: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  AGENT_STATE_PATH: z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
  AGENT_DATA_DIR: z.string().min(1), AGENT_RENDER_ORIGIN: z.url(),
  AGENT_BROWSER_CHANNEL: z.string().optional(),
  AGENT_LEASE_MS: z.coerce.number().int().min(60000).max(3600000),
  AGENT_MIN_QUESTIONS: z.coerce.number().int().min(1).max(200),
  AGENT_MAX_QUESTIONS: z.coerce.number().int().min(1).max(200),
  AGENT_RENDER_RETRY_MS: z.coerce.number().int().min(1000).max(600000),
}).parse(process.env);
if (env.AGENT_MIN_QUESTIONS > env.AGENT_MAX_QUESTIONS) throw new Error('Invalid topic bounds');
if (!env.AGENT_STATE_PATH.startsWith('questionAuthoring/')) throw new Error('Agent state must stay under questionAuthoring');
const origin = new URL(env.AGENT_RENDER_ORIGIN);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !['http:', 'https:'].includes(origin.protocol)
  || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Render origin must be a loopback origin');
export const agentConfig = {
  databaseURL: env.FIREBASE_DATABASE_URL, storageBucket: env.FIREBASE_STORAGE_BUCKET,
  credentials: env.GOOGLE_APPLICATION_CREDENTIALS, statePath: env.AGENT_STATE_PATH,
  dataDir: path.resolve(agentRoot, env.AGENT_DATA_DIR), origin: origin.origin,
  browserChannel: env.AGENT_BROWSER_CHANNEL || undefined, studioRoot: agentRoot,
  recoveryBackoffMs: env.AGENT_RENDER_RETRY_MS, leaseMs: env.AGENT_LEASE_MS,
  minimum: env.AGENT_MIN_QUESTIONS, maximum: env.AGENT_MAX_QUESTIONS,
};
