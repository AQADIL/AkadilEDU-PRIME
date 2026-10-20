import type { ApiCall, ModelPrices, StudioState } from './schema.js';

export interface PublicStateConfig {
  model: string;
  reviewModel: string;
  autoPublish: boolean;
  prices: ModelPrices;
  reviewPrices: ModelPrices;
  repairMaxAttempts: number;
}

export function publicState(state: StudioState, config: PublicStateConfig) {
  const callsById = new Map(state.calls.map(call => [call.id, call]));
  const callsByResponse = new Map(state.calls.filter(call => call.responseId).map(call => [call.responseId!, call]));
  const sampledCalls = new Map<string, number>();
  let acceptedInSample = 0;
  let sampledBatches = 0;
  let incompleteAccounting = false;
  function lineage(call: ApiCall): ApiCall[] | null {
    const collected = new Map<string, ApiCall>();
    const queue = [call];
    while (queue.length) {
      const current = queue.pop()!;
      if (collected.has(current.id)) continue;
      collected.set(current.id, current);
      for (const id of [current.retryOf, current.retryCallId]) {
        if (!id) continue;
        const related = callsById.get(id);
        if (!related) return null;
        if (!collected.has(id)) queue.push(related);
      }
    }
    return [...collected.values()];
  }
  for (const generation of state.calls.filter(call => call.kind === 'generation' && call.model === config.model
    && call.status === 'settled' && !call.retryCallId)) {
    const chain = lineage(generation);
    if (!chain) { incompleteAccounting = true; continue; }
    if (chain.some(call => call.id === state.pendingBatch?.generationCallId || call.id === state.generationCallId)) continue;
    const questions = generation.responseId ? state.questions.filter(question => question.generation.responseId === generation.responseId
      || question.repair?.history.some(entry => entry.generationResponseId === generation.responseId)) : [];
    if (questions.some(question => question.repair?.status === 'pending' || question.repair?.status === 'running')) continue;
    if (questions.some(question => question.generation.reviewModel !== config.reviewModel)) continue;
    if (!questions.length && !generation.terminalReason) { incompleteAccounting = true; continue; }
    const references = new Set<string>();
    let missingReference = false;
    for (const question of questions) {
      references.add(question.generation.responseId);
      references.add(question.generation.reviewResponseId);
      for (const entry of question.repair?.history ?? []) {
        if (entry.generationResponseId) references.add(entry.generationResponseId);
        if (entry.reviewResponseId) references.add(entry.reviewResponseId);
      }
      for (const id of [question.repair?.generationCallId, question.repair?.reviewCallId]) {
        if (!id) continue;
        const call = callsById.get(id);
        if (call) chain.push(call); else missingReference = true;
      }
    }
    for (const responseId of references) {
      const call = callsByResponse.get(responseId);
      if (call) chain.push(call); else missingReference = true;
    }
    const relatedCalls = new Map<string, ApiCall>();
    while (chain.length) {
      const call = chain.pop()!;
      if (relatedCalls.has(call.id)) continue;
      const related = lineage(call);
      if (!related) { missingReference = true; continue; }
      for (const item of related) relatedCalls.set(item.id, item);
      for (const item of related) {
        if (!item.researchResponseId) continue;
        const research = callsByResponse.get(item.researchResponseId);
        if (research) chain.push(research); else missingReference = true;
      }
    }
    const calls = [...relatedCalls.values()];
    if (missingReference) { incompleteAccounting = true; continue; }
    if (calls.some(call => call.status !== 'settled')) continue;
    if (calls.some(call => call.model !== (call.kind === 'review' ? config.reviewModel : config.model))) continue;
    for (const call of calls) sampledCalls.set(call.id, call.cost);
    acceptedInSample += questions.filter(question => question.validation.passed).length;
    sampledBatches += 1;
  }
  const sampleCost = [...sampledCalls.values()].reduce((sum, cost) => sum + cost, 0);
  const costPerAccepted = acceptedInSample && !incompleteAccounting ? sampleCost / acceptedInSample : null;
  const remainingTarget = state.topics.filter(t => t.eligible).reduce((sum, t) => sum + Math.max(0, t.target - t.generated), 0);
  return {
    ...state, calls: undefined, sourceText: undefined, pendingBatch: undefined, generationCallId: undefined,
    model: config.model,
    reviewModel: config.reviewModel,
    autoPublish: config.autoPublish,
    pricing: { generation: config.prices, review: config.reviewPrices },
    repairTotals: {
      queued: state.questions.filter(question => !question.validation.passed
        && (!state.selectedTopicIds.length || state.selectedTopicIds.includes(question.topic))
        && question.repair?.status !== 'exhausted' && question.repair?.status !== 'completed'
        && (question.repair?.status === 'running' || (question.repair?.attempts || 0) < config.repairMaxAttempts)).length,
      completed: state.questions.filter(question => question.repair?.status === 'completed').length,
      exhausted: state.questions.filter(question => question.repair?.status === 'exhausted').length,
    },
    forecast: {
      target: state.topics.filter(t => t.eligible).reduce((sum, t) => sum + t.target, 0),
      costPerAccepted,
      unavailableReason: incompleteAccounting ? 'accounting' : null,
      sampleAccepted: acceptedInSample,
      sampleBatches: sampledBatches,
      estimatedTotal: costPerAccepted === null ? null : state.budget.spent + costPerAccepted * remainingTarget,
    },
  };
}
