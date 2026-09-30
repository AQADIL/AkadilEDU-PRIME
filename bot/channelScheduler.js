const { createHash, randomUUID } = require('node:crypto');
const { Api, InlineKeyboard } = require('grammy');
const { db, transactionLoaded, transactionExisting } = require('./firebase');
const { assertId, listQuestions, shuffle, topicOf, formatQuestion, splitMessage } = require('./quizData');
const { t, normalizeLanguage } = require('./i18n');

function timestamp(value) {
  const result = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid timestamp');
  return result;
}

function apiClient(api) {
  if (api) return api;
  if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN is required');
  return new Api(process.env.BOT_TOKEN);
}

function reviewUrl(publicationId) {
  const base = process.env.BOT_DEEP_LINK_BASE_URL;
  const username = process.env.BOT_USERNAME;
  if (!base || !username || !/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    throw new Error('BOT_DEEP_LINK_BASE_URL and BOT_USERNAME are required');
  }
  const url = new URL(base);
  if (url.protocol !== 'https:' || !['t.me', 'telegram.me'].includes(url.hostname)
    || url.pathname !== `/${username}` || url.search || url.hash || url.port) {
    throw new Error('Invalid BOT_DEEP_LINK_BASE_URL');
  }
  url.searchParams.set('start', `quiz_${publicationId}`);
  return url.toString();
}

function validateCampaign(campaign) {
  if (!campaign || (typeof campaign.channelId !== 'number' && typeof campaign.channelId !== 'string')
    || !/^(@[A-Za-z0-9_]{5,32}|-100\d{1,20})$/.test(String(campaign.channelId))) {
    throw new Error('Invalid channelId');
  }
  for (const [field, maximum] of Object.entries({ questionCount: 50, intervalMinutes: 1440, answerWindowMinutes: 1440 })) {
    if (!Number.isInteger(campaign[field]) || campaign[field] < 1 || campaign[field] > maximum) {
      throw new Error(`Invalid ${field}`);
    }
  }
  if (!['kk', 'ru', 'en'].includes(campaign.language)) {
    throw new Error('Invalid campaign language');
  }
  if (typeof campaign.localRunDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(campaign.localRunDate)) {
    throw new Error('Invalid campaign run date');
  }
  reviewUrl('000000000000000000000000');
}

async function publishDueCampaign(campaignId, campaign, scheduledAt, api) {
  const id = assertId(campaignId);
  const at = timestamp(scheduledAt);
  validateCampaign(campaign);
  const publicationId = createHash('sha256').update(`${id}:${campaign.localRunDate}`).digest('hex').slice(0, 24);
  const reference = db.ref(`publications/${publicationId}`);
  const existing = await reference.once('value');
  if (!existing.exists()) {
    const available = await listQuestions();
    const topicId = campaign.topicId || null;
    const pool = topicId ? available.filter((question) => topicOf(question) === topicId) : available;
    const byTopic = new Map();
    for (const question of pool) {
      const key = topicOf(question);
      if (!key) continue;
      byTopic.set(key, [...(byTopic.get(key) || []), question]);
    }
    const candidates = shuffle([...byTopic.values()].flatMap((questions) => shuffle(questions).slice(0, -1)));
    const selected = candidates.slice(0, campaign.questionCount);
    if (selected.length !== campaign.questionCount) throw new Error('Insufficient published questions for campaign');
    const result = await transactionLoaded(reference, (current) => current || {
      publicationId,
      campaignId: id,
      channelId: campaign.channelId,
      language: normalizeLanguage(campaign.language),
      questions: selected.map((question) => question.id),
      questionData: Object.fromEntries(selected.map((question) => [question.id, question])),
      questionCount: selected.length,
      intervalMinutes: campaign.intervalMinutes,
      answerWindowMinutes: campaign.answerWindowMinutes,
      scheduledAt: at,
      createdAt: Date.now(),
      currentIndex: -1,
      nextActionAt: at,
      status: 'active'
    });
    if (!result.snapshot.exists()) throw new Error('Could not create publication');
  }
  await transactionExisting(db.ref(`campaigns/${id}`), (current) => current
    ? { ...current, lastRunKey: campaign.localRunDate } : undefined);
  await advancePublication(publicationId, Date.now(), apiClient(api));
  return publicationId;
}

async function advancePublication(publicationId, now, api) {
  const ref = db.ref(`publications/${assertId(publicationId)}`);
  const owner = randomUUID();
  const claim = await transactionExisting(ref, (current) => {
    if (!current || current.status !== 'active' || current.nextActionAt > now
      || (current.leaseUntil && current.leaseUntil > now)) return;
    return { ...current, leaseOwner: owner, leaseUntil: now + 90000 };
  });
  if (!claim.committed) return false;
  const publication = claim.snapshot.val();
  const nextIndex = publication.currentIndex + 1;
  try {
    if (nextIndex >= publication.questions.length) {
      const message = await api.sendMessage(publication.channelId, t(publication.language, 'finishChannel'), {
        reply_markup: new InlineKeyboard().url(t(publication.language, 'openReview'), reviewUrl(publicationId))
      });
      await ref.update({ status: 'completed', completedAt: Date.now(), completionMessageId: message.message_id,
        leaseOwner: null, leaseUntil: null, nextActionAt: null });
      return true;
    }
    const questionId = publication.questions[nextIndex];
    const value = publication.questionData?.[questionId];
    if (!value || !Array.isArray(value.options) || !Number.isInteger(value.correctOption)) {
      throw new Error(`Question ${questionId} no longer exists or is invalid`);
    }
    const keyboard = new InlineKeyboard();
    value.options.forEach((option, index) => keyboard.text(String.fromCharCode(65 + index),
      `c:${publicationId}:${nextIndex}:${index}`).row());
    const header = t(publication.language, 'channelQuestion', nextIndex + 1, publication.questionCount);
    const body = formatQuestion(header, value);
    let message;
    if (value.imageUrl && body.length <= 1024) {
      message = await api.sendPhoto(publication.channelId, value.imageUrl, { caption: body, reply_markup: keyboard });
    } else {
      if (value.imageUrl) await api.sendPhoto(publication.channelId, value.imageUrl, { caption: header });
      const chunks = splitMessage(body);
      for (const [index, chunk] of chunks.entries()) {
        message = await api.sendMessage(publication.channelId, chunk,
          index === chunks.length - 1 ? { reply_markup: keyboard } : {});
      }
    }
    const sentAt = Date.now();
    const closesAt = sentAt + publication.answerWindowMinutes * 60000;
    await ref.update({ currentIndex: nextIndex, channelChatId: message.chat.id,
      [`questionPosts/${nextIndex}`]: { messageId: message.message_id, chatId: message.chat.id, sentAt, closesAt },
      nextActionAt: nextIndex + 1 < publication.questions.length
        ? sentAt + publication.intervalMinutes * 60000 : closesAt,
      leaseOwner: null, leaseUntil: null });
    return true;
  } catch (error) {
    await transactionExisting(ref, (current) => current?.leaseOwner === owner
      ? { ...current, leaseOwner: null, leaseUntil: null } : undefined);
    throw error;
  }
}

async function closeDuePublications(now, api) {
  const at = timestamp(now);
  const snapshot = await db.ref('publications').orderByChild('status').equalTo('active').once('value');
  const pending = [];
  snapshot.forEach((child) => {
    if (child.val().nextActionAt <= at) pending.push(child.key);
  });
  const client = apiClient(api);
  const results = await Promise.allSettled(pending.map((id) => advancePublication(id, at, client)));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.filter((result) => result.value).length;
}

module.exports = { publishDueCampaign, closeDuePublications };
