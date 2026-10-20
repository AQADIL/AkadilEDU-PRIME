import { z } from 'zod';

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
  imageUrl?: string;
  localImageUrl?: string;
  imageContainsStatement?: boolean;
};
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
  generation: { model: string; responseId: string; reviewResponseId: string; runId: string; createdAt: number };
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
  rationale?: string;
  coverageGoals?: string[];
}
export interface ApiCall {
  id: string;
  responseId?: string;
  kind: 'generation' | 'review';
  status: 'reserved' | 'pending' | 'settled' | 'uncertain';
  reserved: number;
  cost: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  result?: unknown;
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
  pendingBatch: { questions: GeneratedQuestion[]; generationCallId: string; reviewCallId?: string; sourceEnd?: number } | null;
}

const latex = /\\[A-Za-z]+|\\[()[\]]|\$\$?|\^\{|_\{/;
export function contentIssues(question: GeneratedQuestion): string[] {
  const issues: string[] = [];
  for (const language of languages) {
    const t = question.translations[language];
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
      || d.polygons.some(p => p.vertices.some(id => !ids.has(id)) || new Set(p.vertices).size !== p.vertices.length)) {
      issues.push('Некорректные связи точек чертежа');
    }
  }
  return issues;
}
