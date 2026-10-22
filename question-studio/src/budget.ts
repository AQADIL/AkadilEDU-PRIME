import { z } from 'zod';
import type { ApiCall, StudioState } from './schema.js';

export const budgetCheckpointSchema = z.strictObject({
  source: z.enum(['user-reported-openai-dashboard', 'new-api-credential']),
  credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.number().int().positive(),
  reportedSpent: z.number().nonnegative(),
  additionalLimit: z.number().positive(),
  closedCallIds: z.array(z.uuid()).refine(ids => new Set(ids).size === ids.length),
  reconciliations: z.array(z.strictObject({ createdAt: z.number().int().positive(),
    source: z.literal('user-reported-openai-dashboard'), reportedSpent: z.number().nonnegative(),
    closedCallIds: z.array(z.uuid()) })).optional(),
}).refine(checkpoint => checkpoint.source !== 'new-api-credential'
  || Boolean(checkpoint.credentialFingerprint) && checkpoint.reportedSpent === 0,
  'New credential budgets require their fingerprint and a zero opening balance');
export const budgetHistorySchema = z.array(z.object({ closedAt: z.number().int().positive(),
  spent: z.number().nonnegative(), reserved: z.number().nonnegative(), limit: z.number().positive(),
  checkpoint: budgetCheckpointSchema.optional() }));

export type BudgetCheckpoint = z.infer<typeof budgetCheckpointSchema>;

export function budgetUsage(calls: ApiCall[], budget: StudioState['budget']) {
  const checkpoint = budget.checkpoint;
  const closed = new Set(checkpoint?.closedCallIds ?? []);
  let additionalSpent = 0;
  let reserved = 0;
  let historicalReserved = 0;
  let closedCount = 0;
  for (const call of calls) {
    if (closed.has(call.id)) {
      closedCount++;
      if (call.status !== 'settled' && !call.quarantined) throw new Error('Budget checkpoint contains an active request');
      if (call.status !== 'settled') historicalReserved += call.reserved;
      continue;
    }
    additionalSpent += call.cost;
    if (call.status !== 'settled') reserved += call.reserved;
  }
  if (checkpoint && (closedCount !== closed.size
    || checkpoint.reportedSpent + checkpoint.additionalLimit > budget.limit)) {
    throw new Error('Budget checkpoint is inconsistent with the configured limit or call history');
  }
  return { spent: (checkpoint?.reportedSpent ?? 0) + additionalSpent, reserved, additionalSpent, historicalReserved };
}

export function canReserve(usage: ReturnType<typeof budgetUsage>, budget: StudioState['budget'], amount: number) {
  return usage.spent + usage.reserved + amount <= budget.limit
    && (!budget.checkpoint || usage.additionalSpent + usage.reserved + amount <= budget.checkpoint.additionalLimit);
}
