const { createHash, randomBytes, randomInt, timingSafeEqual } = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');
const logger = require('firebase-functions/logger');
const { z } = require('zod');

const challengeSchema = z.string().regex(/^[a-f0-9]{64}$/);
const requestIdSchema = z.string().regex(/^[a-f0-9]{48}$/);
const verifierSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const displayCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function positiveInteger(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function configuration() {
  const region = process.env.DEPLOY_REGION;
  const databaseURL = process.env.RTDB_URL;
  const deepLinkBaseUrl = process.env.BOT_DEEP_LINK_BASE_URL;
  if (!region || !databaseURL || !deepLinkBaseUrl) {
    throw new Error('Browser authentication configuration is incomplete.');
  }

  let parsedDeepLink;
  try {
    parsedDeepLink = new URL(deepLinkBaseUrl);
  } catch {
    throw new Error('BOT_DEEP_LINK_BASE_URL must be a valid URL.');
  }
  if (parsedDeepLink.protocol !== 'https:' || parsedDeepLink.username || parsedDeepLink.password) {
    throw new Error('BOT_DEEP_LINK_BASE_URL must be a secure public URL.');
  }

  return {
    region,
    databaseURL,
    deepLinkBaseUrl: parsedDeepLink.toString().replace(/\/$/, ''),
    ttlMs: positiveInteger('BROWSER_AUTH_TTL_SECONDS') * 1000,
    rateWindowMs: positiveInteger('BROWSER_AUTH_RATE_WINDOW_SECONDS') * 1000,
    rateMax: positiveInteger('BROWSER_AUTH_RATE_MAX'),
    pollAfterMs: positiveInteger('BROWSER_AUTH_POLL_INTERVAL_MS'),
  };
}

const config = configuration();

function database() {
  const app = getApps()[0] || initializeApp({ databaseURL: config.databaseURL });
  return getDatabase(app);
}

function displayCode() {
  return Array.from({ length: 6 }, () => displayCodeAlphabet[randomInt(displayCodeAlphabet.length)]).join('');
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function equalHex(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function transactionLoaded(reference, updateValue) {
  let listener;
  try {
    await new Promise((resolve, reject) => {
      listener = () => resolve();
      reference.on('value', listener, reject);
    });
    return await reference.transaction(updateValue, undefined, false);
  } finally {
    if (listener) reference.off('value', listener);
  }
}

async function enforceRequestRateLimit(request, now) {
  const networkIdentity = typeof request.rawRequest?.ip === 'string'
    ? request.rawRequest.ip.slice(0, 128)
    : 'unknown';
  const key = hash(`${process.env.GCLOUD_PROJECT || 'firebase'}:${networkIdentity}`);
  const reference = database().ref(`browserAuthRateLimits/${key}`);
  const result = await reference.transaction((current) => {
    if (!current || !Number.isSafeInteger(current.windowStartedAt)
      || now - current.windowStartedAt >= config.rateWindowMs) {
      return { windowStartedAt: now, count: 1, expiresAt: now + config.rateWindowMs * 2 };
    }
    return { ...current, count: Number(current.count || 0) + 1 };
  }, undefined, false);
  if (!result.committed || Number(result.snapshot.val()?.count) > config.rateMax) {
    throw new HttpsError('resource-exhausted', 'Too many sign-in requests. Try again shortly.');
  }
}

exports.beginBrowserAuth = onCall({ region: config.region }, async (request) => {
  const parsed = z.object({ challenge: challengeSchema }).strict().safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'A valid browser challenge is required.');
  }

  const now = Date.now();
  await enforceRequestRateLimit(request, now);
  const requestId = randomBytes(24).toString('hex');
  const code = displayCode();
  const expiresAt = now + config.ttlMs;
  await database().ref(`browserAuthRequests/${requestId}`).set({
    challenge: parsed.data.challenge,
    displayCode: code,
    status: 'pending',
    createdAt: now,
    expiresAt,
  });

  return {
    requestId,
    displayCode: code,
    expiresAt,
    pollAfterMs: config.pollAfterMs,
    botUrl: `${config.deepLinkBaseUrl}?start=admin_${requestId}`,
  };
});

exports.completeBrowserAuth = onCall({ region: config.region }, async (request) => {
  const parsed = z.object({ requestId: requestIdSchema, verifier: verifierSchema }).strict().safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'A valid browser sign-in request is required.');
  }

  const reference = database().ref(`browserAuthRequests/${parsed.data.requestId}`);
  const snapshot = await reference.get();
  const current = snapshot.val();
  if (!current || !equalHex(current.challenge, hash(parsed.data.verifier))) {
    throw new HttpsError('permission-denied', 'Browser sign-in request is invalid.');
  }
  if (!Number.isSafeInteger(current.expiresAt) || current.expiresAt <= Date.now()) {
    throw new HttpsError('deadline-exceeded', 'Browser sign-in request has expired.');
  }
  if (current.status === 'pending') {
    return { status: 'pending', pollAfterMs: config.pollAfterMs };
  }
  if (current.status !== 'approved' || !/^\d{1,16}$/.test(String(current.approvedBy || ''))) {
    throw new HttpsError('failed-precondition', 'Browser sign-in request is no longer available.');
  }

  const telegramId = String(current.approvedBy);
  const [adminSnapshot, userSnapshot] = await Promise.all([
    database().ref(`admins/${telegramId}`).get(),
    database().ref(`users/${telegramId}`).get(),
  ]);
  if (!adminSnapshot.exists()) {
    throw new HttpsError('permission-denied', 'Administrator access has been revoked.');
  }

  const consumedAt = Date.now();
  const consumed = await transactionLoaded(reference, (value) => {
    if (!value || value.status !== 'approved' || String(value.approvedBy) !== telegramId
      || value.expiresAt <= consumedAt || !equalHex(value.challenge, current.challenge)) {
      return;
    }
    return { ...value, status: 'consumed', consumedAt };
  });
  if (!consumed.committed) {
    throw new HttpsError('failed-precondition', 'Browser sign-in request has already been used.');
  }

  try {
    const token = await getAuth().createCustomToken(telegramId, { admin: true });
    const profile = userSnapshot.val() || {};
    return {
      status: 'approved',
      token,
      user: {
        id: Number(telegramId),
        firstName: typeof profile.firstName === 'string' ? profile.firstName : '',
        lastName: typeof profile.lastName === 'string' ? profile.lastName : '',
        username: typeof profile.username === 'string' ? profile.username : '',
        languageCode: typeof profile.language === 'string' ? profile.language : '',
      },
    };
  } catch (error) {
    logger.error('Browser custom token creation failed', {
      code: typeof error.code === 'string' ? error.code : undefined,
    });
    throw new HttpsError('internal', 'Browser authentication failed. Start a new request.');
  }
});

async function cleanupBrowserAuth(now) {
  const root = database();
  const [requests, rateLimits] = await Promise.all([
    root.ref('browserAuthRequests').orderByChild('expiresAt').endAt(now).get(),
    root.ref('browserAuthRateLimits').orderByChild('expiresAt').endAt(now).get(),
  ]);
  const updates = {};
  requests.forEach((child) => { updates[`browserAuthRequests/${child.key}`] = null; });
  rateLimits.forEach((child) => { updates[`browserAuthRateLimits/${child.key}`] = null; });
  if (Object.keys(updates).length > 0) await root.ref().update(updates);
}

exports.cleanupBrowserAuth = cleanupBrowserAuth;
