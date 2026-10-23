import { readFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { applicationDefault, cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getDatabase, type Reference, type DataSnapshot } from 'firebase-admin/database';
import { getStorage, getDownloadURL } from 'firebase-admin/storage';
import { z } from 'zod';
import { agentConfig as config } from './agentConfig.js';
import { agentSchemas, agentStateSchema, agentReviewSchema, completionSchema, planSchema,
  receiptSchema, seedSchema, stageSchema, type AgentState, type StagedBatch } from './agentSchemas.js';
import { contentIssues, languages, type GeneratedQuestion, type StoredQuestion } from './schema.js';
import { renderQuestionWithSettings, closeRenderer } from './renderCore.js';
import { generationPrompt, reviewPrompt, repairPrompt } from './prompts.js';
import { untCurriculum2026 } from './untCurriculum.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, item]) => item !== undefined).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fingerprint = (question: GeneratedQuestion) => createHash('sha256')
  .update(`${question.primaryTopicId}:${question.translations.kk.text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}`).digest('hex');
const recordSchema = z.object({ topic: z.string(), status: z.string().optional(),
  validation: z.object({ passed: z.boolean() }).passthrough().optional(), fingerprint: z.string().optional(),
}).passthrough();
type BankQuestion = z.infer<typeof recordSchema> & { id: string };
const topicSchema = z.object({ name: z.string(), isLast: z.boolean(), parentId: z.string().nullable().optional() }).passthrough();
const leaseSchema = z.object({ token: z.string(), expiresAt: z.number() });
const command = z.enum(['status', 'next', 'schemas', 'plan', 'stage', 'review', 'publish', 'complete', 'seed']).parse(process.argv[2]);

async function main() {
  if (command === 'schemas') return Object.fromEntries(Object.entries(agentSchemas).map(([key, schema]) => [key, z.toJSONSchema(schema)]));
  const credential = config.credentials ? cert(JSON.parse(await readFile(config.credentials, 'utf8'))) : applicationDefault();
  const app = initializeApp({ credential, databaseURL: config.databaseURL, storageBucket: config.storageBucket }, 'question-authoring');
  const db = getDatabase(app);
  const root = db.ref(config.statePath);
  const lease = root.child('lease');
  const token = randomUUID();
  let held = false;
  let leaseError: Error | undefined;
  let renewal: ReturnType<typeof setInterval> | undefined;
  let renewing: Promise<void> = Promise.resolve();
  async function transaction(reference: Reference, update: (value: unknown) => unknown) {
    let listener: ((snapshot: DataSnapshot) => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => { listener = () => resolve(); reference.on('value', listener, reject); });
      return await reference.transaction(update, undefined, false);
    } finally { if (listener) reference.off('value', listener); }
  }
  async function assertLease() {
    if (leaseError) throw leaseError;
    const current = leaseSchema.safeParse((await lease.get()).val());
    if (!current.success || current.data.token !== token || current.data.expiresAt <= Date.now()) throw new Error('Authoring lease expired; retry the same command');
  }
  try {
    const result = await transaction(lease, value => {
      const previous = leaseSchema.safeParse(value);
      if (previous.success && previous.data.expiresAt > Date.now()) return;
      return { token, expiresAt: Date.now() + config.leaseMs };
    });
    if (!result.committed) throw new Error('Another authoring command is running; retry later');
    held = true;
    renewal = setInterval(() => {
      renewing = renewing.then(async () => {
        const renewed = await transaction(lease, value => {
          const current = leaseSchema.safeParse(value);
          if (!current.success || current.data.token !== token || current.data.expiresAt <= Date.now()) return;
          return { token, expiresAt: Date.now() + config.leaseMs };
        });
        if (!renewed.committed) throw new Error('Authoring lease was lost');
      }).catch(error => { leaseError = error instanceof Error ? error : new Error('Lease renewal failed'); });
    }, Math.floor(config.leaseMs / 3));
    const saved = (await root.child('state').get()).val() as unknown;
    const state: AgentState = saved === null ? { version: 1, activeTopicId: null, plans: {}, batch: null }
      : agentStateSchema.parse(JSON.parse(z.string().parse(saved)));
    const rawTopics = z.record(z.string(), topicSchema).parse((await db.ref('topics').get()).val());
    const topics = Object.entries(rawTopics).filter(([id, topic]) => topic.isLast && id.toLowerCase() !== 'random').map(([id, topic]) => {
      const path: string[] = []; const seen = new Set<string>(); let current: string | null | undefined = id;
      while (current) {
        if (seen.has(current)) throw new Error('Topic hierarchy contains a cycle');
        seen.add(current); const node: z.infer<typeof topicSchema> | undefined = rawTopics[current];
        if (!node) throw new Error('Topic parent is missing');
        path.unshift(node.name); current = node.parentId;
      }
      return { id, name: topic.name, path };
    }).sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), 'kk'));
    async function readBank(): Promise<BankQuestion[]> {
      const raw = z.record(z.string(), z.unknown()).parse((await db.ref('questions').get()).val() ?? {});
      return Object.entries(raw).flatMap(([id, value]) => {
        const parsed = recordSchema.safeParse(value);
        return parsed.success ? [{ ...parsed.data, id }] : [];
      });
    }
    let bank = await readBank();
    const accepted = (topicId: string) => bank.filter(q => q.topic === topicId && q.status === 'published' && q.validation?.passed === true);
    const bankFingerprint = (topicId: string) => hash(accepted(topicId).sort((a, b) => a.id.localeCompare(b.id)));
    async function saveState() { await assertLease(); await root.child('state').set(JSON.stringify(state)); }
    const requireTopic = (id: string) => {
      const topic = topics.find(item => item.id === id);
      if (!topic) throw new Error('Unknown or non-leaf topic');
      return topic;
    };
    const remaining = () => topics.filter(topic => state.plans[topic.id]?.status !== 'completed'
      || state.plans[topic.id]?.checkedFingerprint !== bankFingerprint(topic.id));
    async function input() {
      const filename = process.argv[3];
      if (!filename || (await stat(filename)).size > 1000000) throw new Error('Supply a JSON input file under 1 MB');
      return JSON.parse(await readFile(filename, 'utf8')) as unknown;
    }
    function requireActive(id: string) {
      requireTopic(id);
      if (state.activeTopicId !== id) throw new Error('Finish the active topic before switching topics; run next');
    }
    async function next() {
      if (state.batch) return { action: state.batch.status === 'rejected' ? 'repair' : state.batch.status === 'publishing' ? 'publish' : 'review',
        batch: state.batch, prompt: state.batch.status === 'rejected' ? repairPrompt : reviewPrompt };
      const pending = remaining();
      const topic = pending.find(item => item.id === state.activeTopicId && state.plans[item.id]?.status !== 'blocked')
        ?? pending.find(item => state.plans[item.id]?.status !== 'blocked');
      if (!topic) return { action: pending.length ? 'blocked' : 'completed', deferred: pending.map(t => ({ ...t, plan: state.plans[t.id] })) };
      state.activeTopicId = topic.id;
      const plan = state.plans[topic.id];
      if (plan?.status === 'completed') plan.status = 'working';
      await saveState();
      return { action: !plan ? 'plan' : accepted(topic.id).length >= plan.target ? 'audit' : 'generate', topic, plan,
        bankFingerprint: bankFingerprint(topic.id), questions: bank.filter(q => q.topic === topic.id),
        bounds: { minimum: config.minimum, maximum: config.maximum }, difficultyWeights: { easy: 0.25, medium: 0.45, hard: 0.30 },
        curriculum: untCurriculum2026, prompt: generationPrompt };
    }
    if (command === 'status') return { eligibleTopics: topics.length, published: bank.filter(q => q.status === 'published').length,
      completedTopics: topics.length - remaining().length, activeTopicId: state.activeTopicId, pendingBatch: state.batch?.id,
      deferredTopics: Object.values(state.plans).filter(p => p.status === 'blocked').map(p => ({ topicId: p.topicId, reason: p.reason })), paidApiEnabled: false };
    if (command === 'next') return await next();
    if (command === 'seed') {
      const value = seedSchema.parse(await input());
      for (const plan of value.plans) {
        requireTopic(plan.topicId);
        if (plan.target < config.minimum || plan.target > config.maximum) throw new Error('Seed target is outside configured bounds');
        if (!state.plans[plan.topicId]) state.plans[plan.topicId] = { ...plan, status: plan.curriculumRole === 'outside_scope' ? 'blocked' : 'working' };
      }
      await saveState(); return { plans: Object.keys(state.plans).length, completionRequiresFreshAudit: true };
    }
    if (command === 'plan') {
      const plan = planSchema.parse(await input()); requireActive(plan.topicId);
      if (state.batch) throw new Error('Resolve the pending batch before changing its plan');
      if (plan.target < config.minimum || plan.target > config.maximum || new Set(plan.goals.map(g => g.id)).size !== plan.goals.length
        || (plan.curriculumRole !== 'outside_scope' && !plan.curriculumCodes.length)) throw new Error('Invalid topic coverage plan');
      state.plans[plan.topicId] = { ...plan, status: plan.curriculumRole === 'outside_scope' ? 'blocked' : 'working' };
      await saveState(); return await next();
    }
    if (command === 'stage') {
      const value = stageSchema.parse(await input()); requireActive(value.topicId);
      const plan = state.plans[value.topicId];
      if (!plan || plan.status === 'blocked') throw new Error('Plan this topic before writing questions');
      const id = hash(value);
      const receipt = (await root.child(`receipts/${id}`).get()).val();
      if (receipt) return receiptSchema.parse(JSON.parse(z.string().parse(receipt)));
      if (state.batch?.id === id) return { batchId: id, status: state.batch.status };
      if (state.batch && (state.batch.status !== 'rejected' || value.supersedes !== state.batch.id)) throw new Error('Resolve the existing batch first');
      const replacing = value.items.flatMap(item => item.replacesId ? [item.replacesId] : []);
      if (new Set(replacing).size !== replacing.length) throw new Error('Repeated replacement ID');
      const originals: Record<string, string> = {};
      const fingerprints = new Set(bank.filter(q => q.validation?.passed && !replacing.includes(q.id)).map(q => q.fingerprint).filter(Boolean));
      for (const item of value.items) {
        if (item.question.primaryTopicId !== value.topicId) throw new Error('Question belongs to another topic');
        const issues = contentIssues(item.question);
        if (issues.length) throw new Error(issues.join('; '));
        const key = fingerprint(item.question);
        if (fingerprints.has(key)) throw new Error('Duplicate question statement');
        fingerprints.add(key);
        if (item.replacesId) {
          const previous = bank.find(q => q.id === item.replacesId && q.topic === value.topicId);
          if (!previous) throw new Error('Replacement question is missing');
          const { id: _id, ...record } = previous; originals[item.replacesId] = hash(record);
        }
        await renderQuestionWithSettings({ id: hash([id, key]).slice(0, 40), topic: value.topicId,
          difficulty: item.question.difficulty, correctOption: item.question.correctOption,
          translations: structuredClone(item.question.translations), diagram: item.question.diagram,
          status: 'draft', validation: { passed: false, issues: [] }, fingerprint: key,
          generation: { model: value.author.model, responseId: `agent-batch:${id}`, reviewResponseId: '',
            runId: `external-authoring:${config.statePath}`, createdAt: Date.now() } }, config);
      }
      const additions = value.items.filter(item => !item.replacesId).length;
      if (accepted(value.topicId).length + additions > Math.max(accepted(value.topicId).length, plan.target)) throw new Error('Batch exceeds the topic target');
      state.batch = { id, input: value, createdAt: Date.now(), status: 'review', originals };
      await assertLease(); await root.child(`batches/${id}`).set(JSON.stringify(state.batch));
      await saveState(); return { batchId: id, status: 'review', questionCount: value.items.length, prompt: reviewPrompt };
    }
    if (command === 'review') {
      const value = agentReviewSchema.parse(await input());
      const batch = state.batch;
      if (!batch || batch.id !== value.batchId) {
        const receipt = (await root.child(`receipts/${value.batchId}`).get()).val();
        if (receipt) return receiptSchema.parse(JSON.parse(z.string().parse(receipt)));
        throw new Error('Batch is missing or changed');
      }
      if (batch.status === 'publishing') throw new Error('Review is already saved; run publish');
      if (value.reviewer.agentId === batch.input.author.agentId) throw new Error('An independent reviewer is required');
      const reviews = value.verdicts.reviews;
      if (reviews.length !== batch.input.items.length || new Set(reviews.map(r => r.index)).size !== reviews.length
        || reviews.some(r => r.index >= batch.input.items.length)) throw new Error('Review does not cover each question exactly once');
      const issues: string[] = [];
      for (const review of reviews) {
        const q = batch.input.items[review.index]!.question;
        const checks = ['uniqueAnswer', 'mathematicallyCorrect', 'translationsEquivalent', 'explanationsCorrect', 'hintsHelpful', 'topicMatches', 'difficultyMatches', 'diagramCorrect'] as const;
        if (checks.some(check => !review[check]) || review.correctOption !== q.correctOption || (review.needsDiagram && !q.diagram)) issues.push(`Question ${review.index}: review failed`);
        issues.push(...review.issues.map(issue => `Question ${review.index}: ${issue}`));
      }
      batch.review = value; batch.issues = issues; batch.status = issues.length ? 'rejected' : 'publishing';
      await assertLease(); await root.child(`batches/${batch.id}`).set(JSON.stringify(batch));
      await saveState(); return { batchId: batch.id, status: batch.status, issues, next: issues.length ? 'stage corrected items with supersedes' : 'publish' };
    }
    async function publish(batch: StagedBatch) {
      if (batch.status !== 'publishing' || !batch.review) throw new Error('An accepted independent review is required');
      const ids: string[] = [];
      for (const [index, item] of batch.input.items.entries()) {
        await assertLease();
        if ((await db.ref(`topics/${batch.input.topicId}/isLast`).get()).val() !== true) throw new Error('Topic is no longer a leaf');
        const id = item.replacesId ?? hash([batch.id, index]).slice(0, 40);
        const reference = db.ref(`questions/${id}`);
        const existing = (await reference.get()).val() as unknown;
        const existingRecord = existing && typeof existing === 'object' ? existing as Record<string, unknown> : undefined;
        const provenance = existingRecord?.generation as Record<string, unknown> | undefined;
        if (provenance?.agentBatchId === batch.id) {
          if (existingRecord?.status !== 'published' || existingRecord.topic !== batch.input.topicId
            || existingRecord.fingerprint !== fingerprint(item.question)
            || recordSchema.safeParse(existingRecord).data?.validation?.passed !== true) throw new Error('Published batch record changed; inspect it before resuming');
          await db.ref(`questionsByTopic/${batch.input.topicId}/${id}`).set(true); ids.push(id); continue;
        }
        if (item.replacesId ? hash(existing) !== batch.originals[id] : existing !== null) throw new Error('Question changed outside this batch; publication stopped');
        const q = item.question;
        const issues = contentIssues(q); if (issues.length) throw new Error(issues.join('; '));
        const duplicate = bank.find(other => other.id !== id && other.validation?.passed && other.fingerprint === fingerprint(q));
        if (duplicate) throw new Error('Question already exists in the live bank');
        const stored: StoredQuestion = { id, topic: q.primaryTopicId, difficulty: q.difficulty, correctOption: q.correctOption,
          translations: structuredClone(q.translations), diagram: q.diagram, status: 'published', publishedAt: Date.now(),
          validation: { passed: true, issues: [] }, fingerprint: fingerprint(q), generation: {
            model: batch.input.author.model, reviewModel: batch.review.reviewer.model,
            responseId: `agent-batch:${batch.id}`, reviewResponseId: `agent-review:${hash(batch.review)}`,
            runId: `external-authoring:${config.statePath}`, createdAt: batch.createdAt,
          } };
        const images = await renderQuestionWithSettings(stored, config);
        const uploaded = new Map<string, string>();
        if (images) for (const language of languages) {
          const filename = images[language]; let url = uploaded.get(filename);
          if (!url) {
            const data = await readFile(filename); const digest = createHash('sha256').update(data).digest('hex');
            const file = getStorage(app).bucket().file(`questions/${id}/${digest}.png`);
            if (!(await file.exists())[0]) await file.save(data, { resumable: false, metadata: { contentType: 'image/png',
              cacheControl: 'public,max-age=86400', metadata: { firebaseStorageDownloadTokens: randomUUID() } } });
            url = await getDownloadURL(file); uploaded.set(filename, url);
          }
          stored.translations[language].imageUrl = url;
        }
        const translations = Object.fromEntries(languages.map(language => {
          const { localImageUrl: _local, displayText, ...content } = stored.translations[language];
          return [language, { ...content, text: displayText ?? content.text }];
        }));
        const record = JSON.parse(JSON.stringify({ ...translations.kk, translations, topic: stored.topic, difficulty: stored.difficulty,
          correctOption: stored.correctOption, status: stored.status, publishedAt: stored.publishedAt, schemaVersion: 2,
          diagram: stored.diagram, validation: stored.validation, fingerprint: stored.fingerprint,
          generation: { ...stored.generation, source: 'external-agent', agentBatchId: batch.id,
            authorId: batch.input.author.agentId, reviewerId: batch.review.reviewer.agentId },
          createdAt: existingRecord?.createdAt ?? stored.generation.createdAt, updatedAt: Date.now() })) as Record<string, unknown>;
        await assertLease();
        const saved = await transaction(reference, current => {
          if (item.replacesId ? hash(current) !== batch.originals[id] : current !== null) return;
          return record;
        });
        if (!saved.committed) throw new Error('Concurrent question change; retry without overwriting it');
        await db.ref(`questionsByTopic/${stored.topic}/${id}`).set(true);
        const persisted = (await reference.get()).val() as Record<string, unknown> | null;
        if (!persisted || persisted.status !== 'published' || persisted.fingerprint !== stored.fingerprint) throw new Error('Publication read-back failed');
        ids.push(id);
      }
      const receipt = receiptSchema.parse({ batchId: batch.id, review: batch.review, questionIds: ids, publishedAt: Date.now() });
      await assertLease(); await root.child(`receipts/${batch.id}`).set(JSON.stringify(receipt));
      state.batch = null; await saveState(); return receipt;
    }
    if (command === 'publish') {
      if (!state.batch) return { status: 'no_pending_batch' };
      return await publish(state.batch);
    }
    if (command === 'complete') {
      const value = completionSchema.parse(await input()); requireActive(value.topicId);
      if (state.batch) throw new Error('Finish the pending batch before auditing the topic');
      const plan = state.plans[value.topicId]; if (!plan) throw new Error('Topic plan is missing');
      bank = await readBank();
      if (value.bankFingerprint !== bankFingerprint(value.topicId)) throw new Error('Bank changed; repeat the coverage audit');
      const available = new Set(accepted(value.topicId).map(q => q.id));
      const goalIds = new Set(plan.goals.map(g => g.id));
      if (value.coverage.length !== goalIds.size || new Set(value.coverage.map(g => g.goalId)).size !== goalIds.size
        || value.coverage.some(g => !goalIds.has(g.goalId) || g.questionIds.some(id => !available.has(id)))
        || value.issues.some(issue => !bank.some(q => q.id === issue.questionId && q.topic === value.topicId))) throw new Error('Coverage evidence references unknown questions or goals');
      const complete = value.complete && !value.issues.length && !value.missingSkills.length && available.size >= config.minimum
        && value.coverage.every(g => g.questionIds.length > 0) && plan.curriculumRole !== 'outside_scope';
      if (value.complete && !complete) throw new Error('Completion requires all coverage and quality checks');
      plan.completion = value; plan.reason = value.reason; plan.missingSkills = value.missingSkills;
      plan.status = complete ? 'completed' : 'working';
      if (complete) { plan.checkedFingerprint = value.bankFingerprint; state.activeTopicId = null; }
      await saveState(); return { topicId: value.topicId, status: plan.status, published: available.size, next: complete ? 'next' : 'repair or update plan within configured bounds' };
    }
    throw new Error('Unsupported command');
  } finally {
    if (renewal) clearInterval(renewal);
    await renewing;
    if (held) await transaction(lease, value => leaseSchema.safeParse(value).data?.token === token ? null : undefined).catch(() => undefined);
    await closeRenderer(); await deleteApp(app);
  }
}

main().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
  const message = error instanceof z.ZodError ? JSON.stringify(error.issues.map(issue => ({ path: issue.path, message: issue.message })))
    : error instanceof Error ? error.message : 'Authoring command failed';
  process.stderr.write(JSON.stringify({ error: message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]') }) + '\n');
  process.exitCode = 1;
});
