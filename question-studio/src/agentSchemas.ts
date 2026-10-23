import { z } from 'zod';
import { generatedQuestionSchema, reviewSchema } from './schema.js';
import { untCurriculum2026 } from './untCurriculum.js';

export const topicIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const questionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const identitySchema = z.strictObject({ agentId: z.string().min(1).max(160), model: z.string().min(1).max(120) });
const codes = [...Object.keys(untCurriculum2026.mathematics), ...Object.keys(untCurriculum2026.mathematicalLiteracy)];
export const planSchema = z.strictObject({
  topicId: topicIdSchema, target: z.number().int().min(1).max(200),
  goals: z.array(z.strictObject({ id: topicIdSchema, description: z.string().min(1).max(300) })).min(2).max(8),
  curriculumRole: z.enum(['listed', 'prerequisite', 'outside_scope']),
  curriculumCodes: z.array(z.enum(codes)).max(6), reason: z.string().min(1).max(1000),
});
export const stageSchema = z.strictObject({
  topicId: topicIdSchema, author: identitySchema, supersedes: digest.optional(),
  items: z.array(z.strictObject({ question: generatedQuestionSchema, replacesId: questionIdSchema.optional() })).min(1).max(5),
});
export const agentReviewSchema = z.strictObject({
  batchId: digest, reviewer: identitySchema, independent: z.literal(true), verdicts: reviewSchema,
});
export const completionSchema = z.strictObject({
  topicId: topicIdSchema, bankFingerprint: digest, reviewer: identitySchema, independent: z.literal(true), complete: z.boolean(),
  coverage: z.array(z.strictObject({ goalId: topicIdSchema, questionIds: z.array(questionIdSchema).max(200) })).max(8),
  missingSkills: z.array(z.string().min(1).max(300)).max(20),
  issues: z.array(z.strictObject({ questionId: questionIdSchema, issue: z.string().min(1).max(500) })).max(200),
  reason: z.string().min(1).max(1000),
});
export const storedPlanSchema = planSchema.extend({
  status: z.enum(['working', 'completed', 'blocked']), checkedFingerprint: digest.optional(),
  missingSkills: z.array(z.string()).optional(), completion: completionSchema.optional(),
});
export const stagedBatchSchema = z.strictObject({
  id: digest, input: stageSchema, createdAt: z.number(), status: z.enum(['review', 'rejected', 'publishing']),
  originals: z.record(questionIdSchema, digest), review: agentReviewSchema.optional(), issues: z.array(z.string()).optional(),
});
export const agentStateSchema = z.strictObject({
  version: z.literal(1), activeTopicId: topicIdSchema.nullable(),
  plans: z.record(topicIdSchema, storedPlanSchema), batch: stagedBatchSchema.nullable(),
});
export type AgentState = z.infer<typeof agentStateSchema>;
export type StagedBatch = z.infer<typeof stagedBatchSchema>;
export const seedSchema = z.strictObject({ plans: z.array(planSchema).max(1000) });
export const receiptSchema = z.strictObject({ batchId: digest, review: agentReviewSchema, questionIds: z.array(questionIdSchema), publishedAt: z.number() });
export const agentSchemas = { plan: planSchema, stage: stageSchema, review: agentReviewSchema, complete: completionSchema, seed: seedSchema };
