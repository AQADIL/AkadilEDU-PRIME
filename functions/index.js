const crypto = require('node:crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { z } = require('zod');

const botToken = defineSecret('BOT_TOKEN');
const webhookSecret = defineSecret('TELEGRAM_WEBHOOK_SECRET');
const schedule = process.env.SCHEDULER_CRON;

if (!schedule || !schedule.trim()) {
  throw new Error('SCHEDULER_CRON is required to register campaignScheduler');
}

const campaignSchema = z.object({
  name: z.string().min(1),
  language: z.enum(['kk', 'ru', 'en']),
  channelId: z.string().regex(/^(@[A-Za-z0-9_]{5,32}|-100\d{1,20})$/),
  timezone: z.string().min(1).refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  questionCount: z.number().int().min(1).max(50),
  intervalMinutes: z.number().int().min(1).max(1440),
  answerWindowMinutes: z.number().int().min(1).max(1440),
  enabled: z.boolean()
}).passthrough();

let botPromise;

function getBot() {
  if (!botPromise) {
    botPromise = (async () => {
      const { createBot } = require('./bot/index');
      const bot = createBot();
      await bot.init();
      return bot;
    })().catch((error) => {
      botPromise = undefined;
      throw error;
    });
  }
  return botPromise;
}

function matchesSecret(headerValue, expectedValue) {
  if (typeof headerValue !== 'string' || typeof expectedValue !== 'string' || !expectedValue) {
    return false;
  }
  const actual = Buffer.from(headerValue);
  const expected = Buffer.from(expectedValue);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

exports.adminAuth = require('./adminAuth').adminAuth;
exports.beginBrowserAuth = require('./browserAuth').beginBrowserAuth;
exports.completeBrowserAuth = require('./browserAuth').completeBrowserAuth;

exports.verifyChannel = onCall({
  region: process.env.DEPLOY_REGION,
  secrets: [botToken]
}, async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Administrator access is required.');
  }
  const channelId = z.string().regex(/^(@[A-Za-z0-9_]{5,32}|-100\d{1,20})$/).safeParse(request.data?.channelId);
  if (!channelId.success) {
    throw new HttpsError('invalid-argument', 'Enter a valid channel username or ID.');
  }
  try {
    const { getApps, initializeApp } = require('firebase-admin/app');
    const { getDatabase } = require('firebase-admin/database');
    const databaseURL = process.env.RTDB_URL;
    if (!databaseURL) throw new Error('RTDB_URL is required');
    const app = getApps()[0] || initializeApp({ databaseURL });
    const admin = await getDatabase(app).ref(`admins/${request.auth.uid}`).get();
    if (!admin.exists()) {
      throw new HttpsError('permission-denied', 'Administrator access has been revoked.');
    }
    const { Api } = require('grammy');
    const api = new Api(botToken.value());
    const [bot, chat] = await Promise.all([api.getMe(), api.getChat(channelId.data)]);
    if (chat.type !== 'channel') {
      throw new HttpsError('failed-precondition', 'The destination must be a Telegram channel.');
    }
    const member = await api.getChatMember(chat.id, bot.id);
    if (member.status !== 'creator' && (member.status !== 'administrator' || member.can_post_messages !== true)) {
      throw new HttpsError('failed-precondition', 'Add the bot as a channel administrator with permission to post messages.');
    }
    return { channelId: String(chat.id), title: chat.title || '', canPost: true };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error('Channel verification failed', { error });
    throw new HttpsError('failed-precondition', 'Could not verify the channel or bot posting permission.');
  }
});

exports.telegramWebhook = onRequest({
  region: process.env.DEPLOY_REGION,
  secrets: [botToken, webhookSecret],
  maxInstances: 10
}, async (request, response) => {
  if (request.method !== 'POST') {
    response.status(405).end();
    return;
  }
  if (!matchesSecret(request.get('X-Telegram-Bot-Api-Secret-Token'), webhookSecret.value())) {
    response.status(403).end();
    return;
  }
  if (!request.body || typeof request.body !== 'object' || !Number.isSafeInteger(request.body.update_id)) {
    response.status(400).end();
    return;
  }
  try {
    const bot = await getBot();
    await bot.handleUpdate(request.body);
    response.status(200).end();
  } catch (error) {
    logger.error('Telegram webhook processing failed', error);
    response.status(500).end();
  }
});

exports.campaignScheduler = onSchedule({
  schedule,
  timeZone: 'Etc/UTC',
  region: process.env.DEPLOY_REGION,
  secrets: [botToken],
  retryCount: 3,
  maxInstances: 1
}, async (event) => {
  const scheduledAt = Date.parse(event.scheduleTime);
  if (!Number.isFinite(scheduledAt)) {
    throw new Error('Invalid scheduler event time');
  }

  const { db } = require('./bot/firebase');
  const { publishDueCampaign, closeDuePublications } = require('./bot/channelScheduler');
  const { cleanupBrowserAuth } = require('./browserAuth');
  const { Api } = require('grammy');
  const api = new Api(botToken.value());
  const snapshot = await db.ref('campaigns').once('value');
  const campaigns = snapshot.val() || {};
  const failures = [];

  for (const [campaignId, rawCampaign] of Object.entries(campaigns)) {
    if (!rawCampaign || rawCampaign.enabled !== true) {
      continue;
    }
    const parsed = campaignSchema.safeParse(rawCampaign);
    if (!parsed.success) {
      logger.error('Invalid enabled campaign configuration', { campaignId, issues: parsed.error.issues });
      failures.push(campaignId);
      continue;
    }
    const campaign = parsed.data;
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: campaign.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    const localParts = Object.fromEntries(formatter.formatToParts(new Date(scheduledAt))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]));
    const localTime = `${localParts.hour}:${localParts.minute}`;
    if (localTime !== campaign.localTime) {
      continue;
    }
    try {
      const localRunDate = `${localParts.year}-${localParts.month}-${localParts.day}`;
      await publishDueCampaign(campaignId, { ...campaign, localRunDate }, scheduledAt, api);
    } catch (error) {
      logger.error('Campaign publication failed', { campaignId, error });
      failures.push(campaignId);
    }
  }

  try {
    await closeDuePublications(Date.now(), api);
  } catch (error) {
    logger.error('Publication progression failed', error);
    failures.push('publications');
  }

  try {
    await cleanupBrowserAuth(Date.now());
  } catch (error) {
    logger.error('Browser authentication cleanup failed', error);
    failures.push('browserAuthCleanup');
  }

  if (failures.length > 0) {
    throw new Error(`Campaign scheduler failed for ${failures.join(', ')}`);
  }
});
