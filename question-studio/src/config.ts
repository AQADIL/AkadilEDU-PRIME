import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

export const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(studioRoot, '.env'), quiet: true });
if (process.env.STUDIO_ENV_FILE) loadEnv({ path: process.env.STUDIO_ENV_FILE, quiet: true });

const env = z.object({
  STUDIO_HOST: z.enum(['127.0.0.1', '::1']),
  STUDIO_PORT: z.coerce.number().int().min(1024).max(65535),
  STUDIO_PUBLIC_ORIGIN: z.url(),
  STUDIO_DATA_DIR: z.string().min(1),
  STUDIO_BROWSER_CHANNEL: z.string().min(1),
  STUDIO_BUDGET_USD: z.coerce.number().positive().max(50),
  STUDIO_PER_TOPIC: z.coerce.number().int().min(10).max(200),
  STUDIO_BATCH_SIZE: z.coerce.number().int().min(1).max(5),
  STUDIO_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(2000).max(32000),
  STUDIO_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh']),
  STUDIO_AUTO_PUBLISH: z.enum(['true', 'false']),
  OPENAI_API_KEY: z.string().min(20),
  OPENAI_BASE_URL: z.url(),
  OPENAI_MODEL: z.string().min(1),
  OPENAI_INPUT_PRICE_PER_MILLION: z.coerce.number().positive(),
  OPENAI_CACHED_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative(),
  OPENAI_OUTPUT_PRICE_PER_MILLION: z.coerce.number().positive(),
  FIREBASE_DATABASE_URL: z.url(),
  FIREBASE_STORAGE_BUCKET: z.string().min(1),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1),
}).parse(process.env);

const origin = new URL(env.STUDIO_PUBLIC_ORIGIN);
if (origin.hostname !== env.STUDIO_HOST || Number(origin.port) !== env.STUDIO_PORT || origin.protocol !== 'http:'
  || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) {
  throw new Error('STUDIO_PUBLIC_ORIGIN must match the configured local host and port');
}
if (new URL(env.OPENAI_BASE_URL).protocol !== 'https:') throw new Error('OPENAI_BASE_URL must use HTTPS');
export const config = {
  host: env.STUDIO_HOST,
  port: env.STUDIO_PORT,
  origin: origin.origin,
  dataDir: path.resolve(studioRoot, env.STUDIO_DATA_DIR),
  browserChannel: env.STUDIO_BROWSER_CHANNEL,
  budget: env.STUDIO_BUDGET_USD,
  perTopic: env.STUDIO_PER_TOPIC,
  batchSize: env.STUDIO_BATCH_SIZE,
  maxOutputTokens: env.STUDIO_MAX_OUTPUT_TOKENS,
  reasoningEffort: env.STUDIO_REASONING_EFFORT,
  autoPublish: env.STUDIO_AUTO_PUBLISH === 'true',
  apiKey: env.OPENAI_API_KEY,
  apiBase: env.OPENAI_BASE_URL.replace(/\/$/, ''),
  model: env.OPENAI_MODEL,
  inputPrice: env.OPENAI_INPUT_PRICE_PER_MILLION,
  cachedInputPrice: env.OPENAI_CACHED_INPUT_PRICE_PER_MILLION,
  outputPrice: env.OPENAI_OUTPUT_PRICE_PER_MILLION,
  databaseURL: env.FIREBASE_DATABASE_URL,
  storageBucket: env.FIREBASE_STORAGE_BUCKET,
  credentials: path.resolve(env.GOOGLE_APPLICATION_CREDENTIALS),
};
