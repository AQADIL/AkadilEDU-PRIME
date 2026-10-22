import { z } from 'zod';
import { questionPresentationIssues } from './questionPresentation.js';

export const languages = ['kk', 'ru', 'en'] as const;
export type Language = typeof languages[number];
export const difficulties = ['easy', 'medium', 'hard'] as const;
export type Difficulty = typeof difficulties[number];
const label = z.strictObject({ kk: z.string().max(180), ru: z.string().max(180), en: z.string().max(180) });
const coordinate = z.number().min(-10000).max(10000);
const pointId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,15}$/);
export const diagramSchema = z.strictObject({
  kind: z.enum(['geometry', 'plot', 'chart']),
  caption: label,
  points: z.array(z.strictObject({ id: pointId, x: coordinate, y: coordinate, label })).min(2).max(80),
  segments: z.array(z.strictObject({ from: pointId, to: pointId, dashed: z.boolean() })).max(150),
  circles: z.array(z.strictObject({ center: pointId, radius: z.number().positive().max(10000) })).max(20),
  arcs: z.array(z.strictObject({
    center: pointId,
    radiusX: z.number().positive().max(10000),
    radiusY: z.number().positive().max(10000),
    startAngle: z.number().min(-360).max(360),
    endAngle: z.number().min(-360).max(360),
    dashed: z.boolean(),
  })).max(40),
  angles: z.array(z.strictObject({
    vertex: pointId, from: pointId, to: pointId, rightAngle: z.boolean(), label,
  })).max(40),
  polygons: z.array(z.strictObject({ vertices: z.array(pointId).min(3).max(40), fill: z.boolean() })).max(30),
  labels: z.array(z.strictObject({ x: coordinate, y: coordinate, text: label })).max(40),
});
export type Diagram = z.infer<typeof diagramSchema>;
export const translationSchema = z.strictObject({
  text: z.string().min(1).max(3000),
  options: z.array(z.string().min(1).max(400)).length(4),
  explanation: z.string().min(1).max(3000),
  hint: z.string().min(1).max(600),
});
export const generatedQuestionSchema = z.strictObject({
  primaryTopicId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  difficulty: z.enum(difficulties),
  correctOption: z.number().int().min(0).max(3),
  translations: z.strictObject({ kk: translationSchema, ru: translationSchema, en: translationSchema }),
  diagram: diagramSchema.nullable(),
});
export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;
export const generationSchema = z.strictObject({
  recommendedTarget: z.number().int().min(8).max(40),
  rationale: z.string().min(1).max(600),
  coverageGoals: z.array(z.string().min(1).max(200)).min(2).max(8),
  consumedSource: z.string().max(12000),
  questions: z.array(generatedQuestionSchema).max(5),
});
export const pendingBatchSchema = z.strictObject({
  questions: z.array(generatedQuestionSchema).max(5),
  generationCallId: z.uuid(),
  reviewCallId: z.uuid().optional(),
  sourceEnd: z.number().int().nonnegative().optional(),
});
export const generationJobSchema = z.strictObject({
  id: z.uuid(),
  topicId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  count: z.number().int().min(1).max(5),
  difficultyPlan: z.array(z.enum(difficulties)).min(1).max(5),
  stage: z.enum(['research', 'generation', 'review', 'publishing', 'waiting']),
  generationCallId: z.uuid().optional(),
  batch: pendingBatchSchema.optional(),
  retryAt: z.number().int().nonnegative().optional(),
}).refine(job => job.difficultyPlan.length === job.count && (!job.batch || job.batch.questions.length === job.count),
  'Job questions or difficulty plan do not match its count');
export type GenerationJob = z.infer<typeof generationJobSchema>;
export const reviewSchema = z.strictObject({
  reviews: z.array(z.strictObject({
    index: z.number().int().min(0).max(4),
    correctOption: z.number().int().min(0).max(3),
    uniqueAnswer: z.boolean(),
    mathematicallyCorrect: z.boolean(),
    translationsEquivalent: z.boolean(),
    explanationsCorrect: z.boolean(),
    hintsHelpful: z.boolean(),
    topicMatches: z.boolean(),
    difficultyMatches: z.boolean(),
    diagramCorrect: z.boolean(),
    needsDiagram: z.boolean(),
    issues: z.array(z.string().min(1).max(500)).max(12),
  })).min(1).max(5),
});

export type Translation = z.infer<typeof translationSchema> & {
  displayText?: string;
  imageUrl?: string;
  localImageUrl?: string;
  imageContainsStatement?: boolean;
};
export interface ReferenceSource {
  title: string;
  url: string;
}
export interface TopicResearch {
  summary: string;
  sources: ReferenceSource[];
  callId: string;
  responseId: string;
  model: string;
  webSearchCalls: number;
  webToolCalls: number;
  completedAt: number;
}
export interface StoredQuestion {
  id: string;
  topic: string;
  difficulty: Difficulty;
  correctOption: number;
  translations: Record<Language, Translation>;
  diagram: Diagram | null;
  status: 'draft' | 'published' | 'rejected';
  validation: { passed: boolean; issues: string[] };
  fingerprint: string;
  repair?: {
    attempts: number;
    status: 'pending' | 'running' | 'completed' | 'exhausted';
    generationCallId?: string;
    reviewCallId?: string;
    retryAt?: number;
    candidate?: GeneratedQuestion;
    originalQuestion?: GeneratedQuestion;
    databaseRevision?: number;
    originalReviewRequired?: boolean;
    history: { attempt: number; issues: string[]; generationResponseId?: string; reviewResponseId?: string }[];
  };
  generation: {
    model: string;
    reviewModel?: string;
    responseId: string;
    reviewResponseId: string;
    runId: string;
    createdAt: number;
    referenceSources?: ReferenceSource[];
    researchResponseId?: string;
  };
}
export function generatedQuestionContent(question: StoredQuestion): GeneratedQuestion {
  const translations = Object.fromEntries(languages.map(language => {
    const { text, options, explanation, hint } = question.translations[language];
    return [language, { text, options, explanation, hint }];
  }));
  return generatedQuestionSchema.parse({ primaryTopicId: question.topic, difficulty: question.difficulty,
    correctOption: question.correctOption, diagram: question.diagram, translations });
}

export interface Topic {
  id: string;
  name: string;
  path: string[];
  eligible: boolean;
  reason: string | null;
  generated: number;
  target: number;
  targetPlanned: boolean;
  failedBatches?: number;
  requestFailures?: number;
  rationale?: string;
  coverageGoals?: string[];
  researchCallId?: string;
  researchUnavailable?: boolean;
  research?: TopicResearch;
}
export interface ModelPrices {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  webSearch?: number;
}
export interface ApiCall {
  id: string;
  responseId?: string;
  model: string;
  serviceTier?: 'default';
  prices: ModelPrices;
  kind: 'generation' | 'review' | 'research' | 'repair';
  attempt?: number;
  retryOf?: string;
  retryCallId?: string;
  maxOutputTokens?: number;
  terminalReason?: string;
  terminalRetryable?: boolean;
  status: 'reserved' | 'pending' | 'settled' | 'uncertain';
  quarantined?: boolean;
  reserved: number;
  cost: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  webSearchMaxCalls?: number;
  webSearchCalls?: number;
  webToolCalls?: number;
  toolSources?: ReferenceSource[];
  referenceSources?: ReferenceSource[];
  researchResponseId?: string;
  result?: unknown;
}
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export function assertSettledCallWithinReservation(call: ApiCall): void {
  if (call.status !== 'settled') return;
  if (!Number.isFinite(call.cost) || !Number.isFinite(call.reserved) || call.cost < 0 || call.reserved < 0
    || call.cost > call.reserved + 1e-9) {
    throw new Error('Стоимость API-запроса превысила резерв. Новые запросы остановлены до сверки расходов.');
  }
  if (call.kind === 'research' && (!Number.isSafeInteger(call.webSearchCalls) || call.webSearchCalls! < 0
    || !Number.isSafeInteger(call.webSearchMaxCalls) || call.webSearchMaxCalls! < 1)) {
    throw new Error('Не удалось подтвердить число платных поисков. Новые запросы остановлены до сверки расходов.');
  }
}
export function exceededWebSearchLimit(call: ApiCall): boolean {
  return call.kind === 'research' && call.status === 'settled'
    && Number.isSafeInteger(call.webSearchCalls) && Number.isSafeInteger(call.webSearchMaxCalls)
    && call.webSearchCalls! > call.webSearchMaxCalls!;
}
export const usageSchema = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  input_tokens_details: z.object({
    cached_tokens: tokenCount.optional(),
    cache_write_tokens: tokenCount.optional(),
    cache_write_tokens_details: z.object({
      ttl_30m_tokens: tokenCount.optional(),
      ttl_12h_tokens: tokenCount.optional(),
    }).optional(),
  }).optional(),
  output_tokens_details: z.object({ reasoning_tokens: tokenCount.optional() }).optional(),
});

export function calculateUsageCost(rawUsage: unknown, prices: ModelPrices, webSearchCalls = 0) {
  const usage = usageSchema.parse(rawUsage);
  const details = usage.input_tokens_details;
  const cachedInputTokens = details?.cached_tokens ?? 0;
  const ttl = details?.cache_write_tokens_details;
  const ttl30mTokens = ttl?.ttl_30m_tokens ?? 0;
  const ttl12hTokens = ttl?.ttl_12h_tokens ?? 0;
  const cacheWriteTokens = details?.cache_write_tokens ?? ttl30mTokens + ttl12hTokens;
  if (ttl12hTokens > 0) throw new Error('12-hour cache writes have no configured price; reconcile the charge before continuing');
  if (ttl30mTokens + ttl12hTokens > cacheWriteTokens
    || (ttl?.ttl_30m_tokens !== undefined && ttl.ttl_12h_tokens !== undefined
      && ttl30mTokens + ttl12hTokens !== cacheWriteTokens)) {
    throw new Error('Reported cache-write token counts are inconsistent');
  }
  if (cachedInputTokens + cacheWriteTokens > usage.input_tokens) {
    throw new Error('Reported cached and cache-write tokens exceed total input tokens');
  }
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0;
  if (reasoningTokens > usage.output_tokens) throw new Error('Reported reasoning tokens exceed total output tokens');
  for (const price of [prices.input, prices.cachedInput, prices.cacheWrite, prices.output]) {
    if (!Number.isFinite(price) || price < 0) throw new Error('Invalid token price snapshot');
  }
  if (!Number.isSafeInteger(webSearchCalls) || webSearchCalls < 0
    || (webSearchCalls > 0 && (!Number.isFinite(prices.webSearch) || prices.webSearch! < 0))) {
    throw new Error('Invalid web-search accounting data');
  }
  const ordinaryInputTokens = usage.input_tokens - cachedInputTokens - cacheWriteTokens;
  return {
    cost: (ordinaryInputTokens * prices.input + cachedInputTokens * prices.cachedInput
      + cacheWriteTokens * prices.cacheWrite + usage.output_tokens * prices.output) / 1000000
      + webSearchCalls * (prices.webSearch || 0),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens,
    cachedInputTokens,
    cacheWriteTokens,
  };
}
export interface StudioState {
  version: 1;
  runId: string;
  status: 'idle' | 'running' | 'paused' | 'error' | 'budget_exhausted' | 'completed';
  phase: string;
  error: string | null;
  model: string;
  budget: { limit: number; spent: number; reserved: number };
  config: { perTopic: number; batchSize: number; reasoningEffort: string; difficultyWeights: Record<Difficulty, number> };
  topics: Topic[];
  events: { id: string; time: number; level: string; message: string; topicId?: string }[];
  questions: StoredQuestion[];
  calls: ApiCall[];
  totals: { eligible: number; generated: number; published: number; rejected: number };
  activeTopicId: string | null;
  mode: 'generate' | 'parse';
  sourceText: string;
  sourceOffset: number;
  selectedTopicIds: string[];
  generationCallId: string | null;
  pendingBatch: z.infer<typeof pendingBatchSchema> | null;
  jobs?: GenerationJob[];
}

const latex = /\\[A-Za-z]+|\\[()[\]]|\$\$?|\^\{|_\{/;
export function contentIssues(question: GeneratedQuestion): string[] {
  const issues = questionPresentationIssues(question.translations);
  for (const language of languages) {
    const t = question.translations[language];
    const outsideMath = t.text.replace(/\$\$[\s\S]*?\$\$|\$[^$]*?\$/g, '');
    if (latex.test(outsideMath)) issues.push(`${language}: формулы LaTeX в условии должны быть внутри $...$ или $$...$$`);
    if (new Set(t.options.map(v => v.normalize('NFKC').trim().toLowerCase())).size !== 4) {
      issues.push(`${language}: повторяющиеся варианты ответа`);
    }
    if ([...t.options, t.explanation, t.hint].some(value => latex.test(value))) {
      issues.push(`${language}: LaTeX разрешён только в условии`);
    }
  }
  if (question.diagram) {
    const d = question.diagram;
    const ids = new Set(d.points.map(p => p.id));
    if (ids.size !== d.points.length) issues.push('Повторяющиеся точки чертежа');
    if (d.segments.some(s => s.from === s.to || !ids.has(s.from) || !ids.has(s.to))
      || d.circles.some(c => !ids.has(c.center))
      || (d.arcs || []).some(a => !ids.has(a.center))
      || (d.angles || []).some(a => !ids.has(a.vertex) || !ids.has(a.from) || !ids.has(a.to))
      || d.polygons.some(p => p.vertices.some(id => !ids.has(id)) || new Set(p.vertices).size !== p.vertices.length)) {
      issues.push('Некорректные связи точек чертежа');
    }
    for (const arc of d.arcs || []) {
      const sweep = Math.abs(arc.endAngle - arc.startAngle);
      if (sweep === 0 || sweep > 360) issues.push('Дуга должна иметь ненулевой угол обхода не более 360°');
    }
    const points = new Map(d.points.map(point => [point.id, point]));
    for (const angle of d.angles || []) {
      const vertex = points.get(angle.vertex), from = points.get(angle.from), to = points.get(angle.to);
      if (!vertex || !from || !to) continue;
      const ax = from.x - vertex.x, ay = from.y - vertex.y;
      const bx = to.x - vertex.x, by = to.y - vertex.y;
      const lengthProduct = Math.hypot(ax, ay) * Math.hypot(bx, by);
      if (lengthProduct === 0) {
        issues.push('Луч обозначенного угла имеет нулевую длину');
        continue;
      }
      const normalizedDot = (ax * bx + ay * by) / lengthProduct;
      if (Math.abs(ax * by - ay * bx) / lengthProduct < 1e-10 && normalizedDot > 0) {
        issues.push('Лучи обозначенного угла совпадают');
      }
      if (angle.rightAngle && Math.abs(normalizedDot) > 1e-6) {
        issues.push('Обозначение прямого угла не соответствует координатам');
      }
    }
  }
  return issues;
}
