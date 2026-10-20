import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

export const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(studioRoot, '.env'), quiet: true });
if (process.env.STUDIO_ENV_FILE) loadEnv({ path: process.env.STUDIO_ENV_FILE, quiet: true });

const env = z.object({
  STUDIO_EXECUTION_OWNER: z.enum(['local', 'google-apps-script']).optional(),
  STUDIO_HOST: z.enum(['127.0.0.1', '::1']),
  STUDIO_PORT: z.coerce.number().int().min(1024).max(65535),
  STUDIO_PUBLIC_ORIGIN: z.url(),
  STUDIO_DATA_DIR: z.string().min(1),
  STUDIO_BROWSER_CHANNEL: z.string().min(1),
  STUDIO_BUDGET_USD: z.coerce.number().positive().max(50),
  STUDIO_PER_TOPIC: z.coerce.number().int().min(10).max(200),
  STUDIO_BATCH_SIZE: z.coerce.number().int().min(1).max(5),
  STUDIO_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(2000).max(32000),
  STUDIO_API_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5),
  STUDIO_RETRY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(2000).max(64000),
  STUDIO_REPAIR_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(3),
  STUDIO_MAX_TOPIC_FAILURES: z.coerce.number().int().min(1).max(10),
  STUDIO_RECOVERY_BACKOFF_MS: z.coerce.number().int().min(1000).max(600000),
  STUDIO_STATE_WRITE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000),
  STUDIO_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh']),
  STUDIO_AUTO_PUBLISH: z.enum(['true', 'false']),
  STUDIO_WEB_SEARCH_ENABLED: z.enum(['true', 'false']),
  STUDIO_WEB_SEARCH_INPUT_TOKEN_RESERVE: z.coerce.number().int().min(128000).max(200000),
  STUDIO_WEB_SEARCH_MAX_CALLS: z.coerce.number().int().min(1).max(1),
  OPENAI_API_KEY: z.string().min(20),
  OPENAI_BASE_URL: z.url(),
  OPENAI_MODEL: z.string().min(1),
  OPENAI_REVIEW_MODEL: z.string().min(1),
  OPENAI_REVIEW_INPUT_PRICE_PER_MILLION: z.coerce.number().positive(),
  OPENAI_REVIEW_CACHED_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative(),
  OPENAI_REVIEW_CACHE_WRITE_PRICE_PER_MILLION: z.coerce.number().positive(),
  OPENAI_REVIEW_OUTPUT_PRICE_PER_MILLION: z.coerce.number().positive(),
  OPENAI_SERVICE_TIER: z.literal('default'),
  OPENAI_INPUT_PRICE_PER_MILLION: z.coerce.number().positive(),
  OPENAI_CACHED_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative(),
  OPENAI_CACHE_WRITE_PRICE_PER_MILLION: z.coerce.number().positive(),
  OPENAI_OUTPUT_PRICE_PER_MILLION: z.coerce.number().positive(),
  OPENAI_WEB_SEARCH_PRICE_PER_CALL: z.coerce.number().positive(),
  OPENAI_LEGACY_MODEL: z.string().min(1).optional(),
  OPENAI_LEGACY_INPUT_PRICE_PER_MILLION: z.coerce.number().positive().optional(),
  OPENAI_LEGACY_CACHED_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().optional(),
  OPENAI_LEGACY_CACHE_WRITE_PRICE_PER_MILLION: z.coerce.number().positive().optional(),
  OPENAI_LEGACY_OUTPUT_PRICE_PER_MILLION: z.coerce.number().positive().optional(),
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
if (env.STUDIO_RETRY_MAX_OUTPUT_TOKENS < env.STUDIO_MAX_OUTPUT_TOKENS) {
  throw new Error('STUDIO_RETRY_MAX_OUTPUT_TOKENS must be at least STUDIO_MAX_OUTPUT_TOKENS');
}
const legacyPricing = {
  model: env.OPENAI_LEGACY_MODEL,
  input: env.OPENAI_LEGACY_INPUT_PRICE_PER_MILLION,
  cachedInput: env.OPENAI_LEGACY_CACHED_INPUT_PRICE_PER_MILLION,
  cacheWrite: env.OPENAI_LEGACY_CACHE_WRITE_PRICE_PER_MILLION,
  output: env.OPENAI_LEGACY_OUTPUT_PRICE_PER_MILLION,
};
if (Object.values(legacyPricing).some(value => value !== undefined)
  && Object.values(legacyPricing).some(value => value === undefined)) {
  throw new Error('Legacy model pricing requires OPENAI_LEGACY_MODEL and input, cached-input, cache-write and output legacy prices');
}
export const config = {
  executionOwner: env.STUDIO_EXECUTION_OWNER,
  host: env.STUDIO_HOST,
  port: env.STUDIO_PORT,
  origin: origin.origin,
  dataDir: path.resolve(studioRoot, env.STUDIO_DATA_DIR),
  browserChannel: env.STUDIO_BROWSER_CHANNEL,
  budget: env.STUDIO_BUDGET_USD,
  perTopic: env.STUDIO_PER_TOPIC,
  batchSize: env.STUDIO_BATCH_SIZE,
  maxOutputTokens: env.STUDIO_MAX_OUTPUT_TOKENS,
  apiMaxAttempts: env.STUDIO_API_MAX_ATTEMPTS,
  retryMaxOutputTokens: env.STUDIO_RETRY_MAX_OUTPUT_TOKENS,
  repairMaxAttempts: env.STUDIO_REPAIR_MAX_ATTEMPTS,
  maxTopicFailures: env.STUDIO_MAX_TOPIC_FAILURES,
  recoveryBackoffMs: env.STUDIO_RECOVERY_BACKOFF_MS,
  stateWriteTimeoutMs: env.STUDIO_STATE_WRITE_TIMEOUT_MS,
  reasoningEffort: env.STUDIO_REASONING_EFFORT,
  autoPublish: env.STUDIO_AUTO_PUBLISH === 'true',
  webSearchEnabled: env.STUDIO_WEB_SEARCH_ENABLED === 'true',
  webSearchInputTokenReserve: env.STUDIO_WEB_SEARCH_INPUT_TOKEN_RESERVE,
  webSearchMaxCalls: env.STUDIO_WEB_SEARCH_MAX_CALLS,
  webSearchPricePerCall: env.OPENAI_WEB_SEARCH_PRICE_PER_CALL,
  apiKey: env.OPENAI_API_KEY,
  apiBase: env.OPENAI_BASE_URL.replace(/\/$/, ''),
  model: env.OPENAI_MODEL,
  reviewModel: env.OPENAI_REVIEW_MODEL,
  reviewPrices: {
    input: env.OPENAI_REVIEW_INPUT_PRICE_PER_MILLION,
    cachedInput: env.OPENAI_REVIEW_CACHED_INPUT_PRICE_PER_MILLION,
    cacheWrite: env.OPENAI_REVIEW_CACHE_WRITE_PRICE_PER_MILLION,
    output: env.OPENAI_REVIEW_OUTPUT_PRICE_PER_MILLION,
  },
  serviceTier: env.OPENAI_SERVICE_TIER,
  inputPrice: env.OPENAI_INPUT_PRICE_PER_MILLION,
  cachedInputPrice: env.OPENAI_CACHED_INPUT_PRICE_PER_MILLION,
  cacheWritePrice: env.OPENAI_CACHE_WRITE_PRICE_PER_MILLION,
  outputPrice: env.OPENAI_OUTPUT_PRICE_PER_MILLION,
  prices: {
    input: env.OPENAI_INPUT_PRICE_PER_MILLION,
    cachedInput: env.OPENAI_CACHED_INPUT_PRICE_PER_MILLION,
    cacheWrite: env.OPENAI_CACHE_WRITE_PRICE_PER_MILLION,
    output: env.OPENAI_OUTPUT_PRICE_PER_MILLION,
  },
  legacyPricing: legacyPricing.model !== undefined && legacyPricing.input !== undefined
    && legacyPricing.cachedInput !== undefined && legacyPricing.cacheWrite !== undefined && legacyPricing.output !== undefined
    ? { model: legacyPricing.model, prices: {
      input: legacyPricing.input, cachedInput: legacyPricing.cachedInput,
      cacheWrite: legacyPricing.cacheWrite, output: legacyPricing.output,
    } } : undefined,
  databaseURL: env.FIREBASE_DATABASE_URL,
  storageBucket: env.FIREBASE_STORAGE_BUCKET,
  credentials: path.resolve(env.GOOGLE_APPLICATION_CREDENTIALS),
};
