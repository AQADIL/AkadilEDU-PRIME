import type { ApiCall, ModelPrices, StoredQuestion, StudioState } from './schema.js';
import { budgetUsage } from './budget.js';

export interface PublicStateConfig {
  model: string;
  reviewModel: string;
  autoPublish: boolean;
  prices: ModelPrices;
  reviewPrices: ModelPrices;
  repairMaxAttempts: number;
  concurrency?: number;
  detailRevision?: number;
}

export function publicState(state: StudioState, config: PublicStateConfig) {
  const callsById = new Map(state.calls.map(call => [call.id, call]));
  const callsByResponse = new Map(state.calls.filter(call => call.responseId).map(call => [call.responseId!, call]));
  const questionsByResponse = new Map<string, StoredQuestion[]>();
  for (const question of state.questions) {
    const references = new Set([question.generation.responseId,
      ...(question.repair?.history.map(entry => entry.generationResponseId).filter((id): id is string => Boolean(id)) ?? [])]);
    for (const responseId of references) {
      const questions = questionsByResponse.get(responseId) ?? [];
      questions.push(question);
      questionsByResponse.set(responseId, questions);
    }
  }
  const activeCalls = new Set([state.pendingBatch?.generationCallId, state.generationCallId,
    ...(state.jobs ?? []).flatMap(job => [job.generationCallId, job.batch?.generationCallId])]);
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
    if (chain.some(call => activeCalls.has(call.id))) continue;
    const questions = generation.responseId ? questionsByResponse.get(generation.responseId) ?? [] : [];
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
  const repairs = state.questions.filter(question => question.repair?.status === 'running');
  const accounting = budgetUsage(state.calls, state.budget);
  const activeTopicIds = state.activeTopicId ? [state.activeTopicId]
    : [...new Set([...(state.jobs ?? []).map(job => job.topicId), ...repairs.map(question => question.topic)])];
  const currentTopic = state.topics.find(topic => topic.id === state.activeTopicId);
  const coverageTopics = state.topics.filter(topic => topic.progress?.status === 'checking');
  const preflight = !state.activeTopicId && state.status === 'running' && coverageTopics.length > 0;
  const visibleJobs = state.activeTopicId ? (state.jobs ?? []).filter(job => job.topicId === state.activeTopicId) : preflight ? [] : state.jobs ?? [];
  return {
    ...state, calls: undefined, sourceText: undefined, pendingBatch: undefined, generationCallId: undefined, jobs: undefined,
    detailRevision: config.detailRevision,
    questions: state.questions.map(question => config.detailRevision !== undefined ? {
      id: question.id, topic: question.topic, status: question.status, difficulty: question.difficulty,
      publishedAt: question.publishedAt, generation: { createdAt: question.generation.createdAt },
      validation: { passed: question.validation.passed },
    } : question.repair ? { ...question, repair: {
      status: question.repair.status, attempts: question.repair.attempts, history: question.repair.history,
    } } : question),
    topics: state.topics.map(topic => topic.progress ? { ...topic, progress: { ...topic.progress, audit: undefined } } : topic),
    budget: { ...state.budget, checkpoint: undefined, history: undefined,
      ...(state.budget.checkpoint ? { allowance: {
        source: state.budget.checkpoint.source, reportedSpent: state.budget.checkpoint.reportedSpent,
        limit: state.budget.checkpoint.additionalLimit, spent: accounting.additionalSpent,
        historicalReserved: accounting.historicalReserved,
        historicalSpent: state.budget.history?.at(-1)?.spent ?? state.budget.checkpoint.reportedSpent,
      } } : {}),
    },
    activeTopicIds,
    ...(config.concurrency ? { pipeline: {
      concurrency: state.mode === 'parse' ? 1 : config.concurrency,
      activeRequests: state.calls.filter(call => call.status === 'reserved' || call.status === 'pending').length,
      currentTopic: currentTopic ? { name: currentTopic.name, status: currentTopic.progress?.status } : null,
      completedTopics: state.topics.filter(topic => topic.progress?.status === 'completed').length,
      totalTopics: state.topics.filter(topic => topic.eligible).length,
      jobs: [
        ...visibleJobs.map(job => ({ id: job.id, topicId: job.topicId,
          topicName: state.topics.find(topic => topic.id === job.topicId)?.name ?? job.topicId,
          stage: job.stage, count: job.count, retryAt: job.retryAt })),
        ...(preflight ? [] : repairs).map(question => ({ id: `repair:${question.id}`, topicId: question.topic,
          topicName: state.topics.find(topic => topic.id === question.topic)?.name ?? question.topic,
          stage: (question.repair?.retryAt ?? 0) > Date.now() ? 'waiting' : question.repair?.candidate ? 'review' : 'generation',
          count: 1, retryAt: question.repair?.retryAt })),
        ...coverageTopics.filter(topic => preflight || topic.id === state.activeTopicId).map(topic => ({
          id: `coverage:${topic.id}`, topicId: topic.id, topicName: topic.name, stage: 'coverage', count: topic.generated })),
      ],
    } } : {}),
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
