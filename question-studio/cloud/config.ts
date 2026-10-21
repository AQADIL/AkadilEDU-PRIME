import { z } from 'zod';

const httpsUrl = z.string().regex(/^https:\/\/[A-Za-z0-9.-]+(?::443)?(?:\/[^\s?#]*)?$/);
const positive = z.coerce.number().positive();
declare const DEPLOYMENT_CLOUD_DAILY_RUNTIME_MS: string;
const runtimeLimitSchema = z.coerce.number().int().min(60000).max(5400000);
export function deploymentRuntimeLimit() { return runtimeLimitSchema.parse(DEPLOYMENT_CLOUD_DAILY_RUNTIME_MS); }
const envSchema = z.object({
  STUDIO_BUDGET_USD: positive.max(50),
  STUDIO_PER_TOPIC: z.coerce.number().int().min(10).max(200),
  STUDIO_BATCH_SIZE: z.coerce.number().int().min(1).max(5),
  STUDIO_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(2000).max(32000),
  STUDIO_API_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5),
  STUDIO_RETRY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(2000).max(64000),
  STUDIO_REPAIR_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(3),
  STUDIO_MAX_TOPIC_FAILURES: z.coerce.number().int().min(1).max(10),
  STUDIO_RECOVERY_BACKOFF_MS: z.coerce.number().int().min(1000).max(600000),
  STUDIO_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh']),
  STUDIO_GENERATION_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  STUDIO_REVIEW_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  STUDIO_RESEARCH_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  STUDIO_AUTO_PUBLISH: z.enum(['true', 'false']),
  STUDIO_WEB_SEARCH_ENABLED: z.enum(['true', 'false']),
  STUDIO_WEB_SEARCH_INPUT_TOKEN_RESERVE: z.coerce.number().int().min(128000).max(200000),
  STUDIO_WEB_SEARCH_MAX_CALLS: z.coerce.number().int().min(1).max(1),
  OPENAI_API_KEY: z.string().min(20),
  OPENAI_BASE_URL: httpsUrl,
  OPENAI_MODEL: z.string().min(1),
  OPENAI_REVIEW_MODEL: z.string().min(1),
  OPENAI_REVIEW_INPUT_PRICE_PER_MILLION: positive,
  OPENAI_REVIEW_CACHED_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative(),
  OPENAI_REVIEW_CACHE_WRITE_PRICE_PER_MILLION: positive,
  OPENAI_REVIEW_OUTPUT_PRICE_PER_MILLION: positive,
  OPENAI_SERVICE_TIER: z.literal('default'),
  OPENAI_INPUT_PRICE_PER_MILLION: positive,
  OPENAI_CACHED_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative(),
  OPENAI_CACHE_WRITE_PRICE_PER_MILLION: positive,
  OPENAI_OUTPUT_PRICE_PER_MILLION: positive,
  OPENAI_WEB_SEARCH_PRICE_PER_CALL: positive,
  FIREBASE_DATABASE_URL: httpsUrl,
  FIREBASE_STORAGE_BUCKET: z.string().regex(/^[A-Za-z0-9.-]+$/),
  FIREBASE_OAUTH_URL: httpsUrl,
  FIREBASE_STORAGE_API_URL: httpsUrl,
  FIREBASE_STORAGE_DOWNLOAD_URL: httpsUrl,
  FIREBASE_DATABASE_SCOPE: httpsUrl,
  GOOGLE_EMAIL_SCOPE: httpsUrl,
  GOOGLE_STORAGE_SCOPE: httpsUrl,
  GOOGLE_SLIDES_API_URL: httpsUrl,
  STUDIO_OWNER_EMAIL: z.email(),
  STUDIO_CLOUD_TICK_MINUTES: z.coerce.number().pipe(z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(15), z.literal(30)])),
  STUDIO_CLOUD_DAILY_RUNTIME_MS: runtimeLimitSchema,
});

function readConfig() {
  const env = envSchema.parse(PropertiesService.getScriptProperties().getProperties());
  if (env.STUDIO_RETRY_MAX_OUTPUT_TOKENS < env.STUDIO_MAX_OUTPUT_TOKENS) throw new Error('Retry token limit is too small');
  return {
    budget: env.STUDIO_BUDGET_USD, perTopic: env.STUDIO_PER_TOPIC, batchSize: env.STUDIO_BATCH_SIZE,
    maxOutputTokens: env.STUDIO_MAX_OUTPUT_TOKENS, apiMaxAttempts: env.STUDIO_API_MAX_ATTEMPTS,
    retryMaxOutputTokens: env.STUDIO_RETRY_MAX_OUTPUT_TOKENS, repairMaxAttempts: env.STUDIO_REPAIR_MAX_ATTEMPTS,
    maxTopicFailures: env.STUDIO_MAX_TOPIC_FAILURES, recoveryBackoffMs: env.STUDIO_RECOVERY_BACKOFF_MS,
    reasoningEffort: env.STUDIO_REASONING_EFFORT, autoPublish: env.STUDIO_AUTO_PUBLISH === 'true',
    generationReasoningEffort: env.STUDIO_GENERATION_REASONING_EFFORT ?? env.STUDIO_REASONING_EFFORT,
    reviewReasoningEffort: env.STUDIO_REVIEW_REASONING_EFFORT ?? env.STUDIO_REASONING_EFFORT,
    researchReasoningEffort: env.STUDIO_RESEARCH_REASONING_EFFORT ?? env.STUDIO_REASONING_EFFORT,
    webSearchEnabled: env.STUDIO_WEB_SEARCH_ENABLED === 'true', webSearchInputTokenReserve: env.STUDIO_WEB_SEARCH_INPUT_TOKEN_RESERVE,
    webSearchMaxCalls: env.STUDIO_WEB_SEARCH_MAX_CALLS, webSearchPricePerCall: env.OPENAI_WEB_SEARCH_PRICE_PER_CALL,
    apiKey: env.OPENAI_API_KEY, apiBase: env.OPENAI_BASE_URL.replace(/\/$/, ''), model: env.OPENAI_MODEL,
    reviewModel: env.OPENAI_REVIEW_MODEL, serviceTier: env.OPENAI_SERVICE_TIER,
    prices: { input: env.OPENAI_INPUT_PRICE_PER_MILLION, cachedInput: env.OPENAI_CACHED_INPUT_PRICE_PER_MILLION,
      cacheWrite: env.OPENAI_CACHE_WRITE_PRICE_PER_MILLION, output: env.OPENAI_OUTPUT_PRICE_PER_MILLION },
    reviewPrices: { input: env.OPENAI_REVIEW_INPUT_PRICE_PER_MILLION, cachedInput: env.OPENAI_REVIEW_CACHED_INPUT_PRICE_PER_MILLION,
      cacheWrite: env.OPENAI_REVIEW_CACHE_WRITE_PRICE_PER_MILLION, output: env.OPENAI_REVIEW_OUTPUT_PRICE_PER_MILLION },
    databaseURL: env.FIREBASE_DATABASE_URL.replace(/\/$/, ''), storageBucket: env.FIREBASE_STORAGE_BUCKET,
    firebaseOAuthUrl: env.FIREBASE_OAUTH_URL, firebaseStorageApiUrl: env.FIREBASE_STORAGE_API_URL,
    firebaseStorageDownloadUrl: env.FIREBASE_STORAGE_DOWNLOAD_URL, firebaseDatabaseScope: env.FIREBASE_DATABASE_SCOPE,
    googleEmailScope: env.GOOGLE_EMAIL_SCOPE, googleStorageScope: env.GOOGLE_STORAGE_SCOPE, googleSlidesApiUrl: env.GOOGLE_SLIDES_API_URL,
    ownerEmail: env.STUDIO_OWNER_EMAIL.toLowerCase(), tickMinutes: env.STUDIO_CLOUD_TICK_MINUTES,
    dailyRuntimeMs: env.STUDIO_CLOUD_DAILY_RUNTIME_MS,
  };
}
export let config: ReturnType<typeof readConfig>;
export function initializeConfig() { config = readConfig(); }
