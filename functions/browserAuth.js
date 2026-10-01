const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');
const logger = require('firebase-functions/logger');
const { z } = require('zod');
const { matchesBrowserOtp } = require('./bot/browserAuthOtp');

const challengeSchema = z.string().regex(/^[a-f0-9]{64}$/);
const requestIdSchema = z.string().regex(/^[a-f0-9]{48}$/);
const verifierSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const otpSchema = z.string().regex(/^\d{4}$/);
const browserOtpPepper = defineSecret('BROWSER_AUTH_OTP_PEPPER');

function positiveInteger(name, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
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
    otpMaxAttempts: positiveInteger('BROWSER_AUTH_OTP_MAX_ATTEMPTS', 5),
  };
}

const config = configuration();

function database() {
  const app = getApps()[0] || initializeApp({ databaseURL: config.databaseURL });
  return getDatabase(app);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function equalHex(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function telegramId(value) {
  const normalized = String(value || '');
  return /^\d{1,16}$/.test(normalized) ? normalized : null;
}

function authError(code, message, reason) {
  return new HttpsError(code, message, { reason });
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
  const expiresAt = now + config.ttlMs;
  await database().ref(`browserAuthRequests/${requestId}`).set({
    challenge: parsed.data.challenge,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    expiresAt,
  });

  return {
    requestId,
    expiresAt,
    botUrl: `${config.deepLinkBaseUrl}?start=admin_${requestId}`,
  };
});

exports.completeBrowserAuth = onCall({
  region: config.region,
  secrets: [browserOtpPepper],
}, async (request) => {
  const parsed = z.object({
    requestId: requestIdSchema,
    verifier: verifierSchema,
    otp: otpSchema,
  }).strict().safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'A valid browser sign-in request is required.');
  }

  const reference = database().ref(`browserAuthRequests/${parsed.data.requestId}`);
  const snapshot = await reference.get();
  const current = snapshot.val();
  const challenge = hash(parsed.data.verifier);
  if (!current || !equalHex(current.challenge, challenge)) {
    throw authError('permission-denied', 'Browser sign-in request is invalid.', 'invalid-request');
  }
  if (!Number.isSafeInteger(current.expiresAt) || current.expiresAt <= Date.now()) {
    throw authError('deadline-exceeded', 'Browser sign-in request has expired.', 'expired');
  }
  if (current.status === 'pending') {
    throw authError('failed-precondition', 'Open the Telegram bot to receive the code.', 'code-not-sent');
  }
  if (current.status === 'locked') {
    throw authError('resource-exhausted', 'Too many incorrect code attempts.', 'attempts-exhausted');
  }
  if (current.status !== 'otp_issued' || !telegramId(current.issuedTo)) {
    throw authError('failed-precondition', 'Browser sign-in request is no longer available.', 'unavailable');
  }

  const attemptedAt = Date.now();
  const attemptId = randomBytes(16).toString('hex');
  const result = await transactionLoaded(reference, (value) => {
    if (!value || value.status !== 'otp_issued' || value.expiresAt <= attemptedAt
      || !equalHex(value.challenge, challenge) || !telegramId(value.issuedTo)) {
      return;
    }
    const attempts = Number.isSafeInteger(value.attempts) ? value.attempts : 0;
    if (attempts >= config.otpMaxAttempts) return;
    if (!matchesBrowserOtp(value.otpHash, parsed.data.requestId, value.challenge, parsed.data.otp)) {
      const nextAttempts = attempts + 1;
      return {
        ...value,
        attempts: nextAttempts,
        lastAttemptAt: attemptedAt,
        lastAttemptId: attemptId,
        status: nextAttempts >= config.otpMaxAttempts ? 'locked' : 'otp_issued',
        otpHash: nextAttempts >= config.otpMaxAttempts ? null : value.otpHash,
      };
    }
    return {
      ...value,
      status: 'consumed',
      consumedAt: attemptedAt,
      consumedAttemptId: attemptId,
      otpHash: null,
      lastAttemptId: null,
    };
  });

  const verified = result.snapshot.val();
  if (!result.committed) {
    if (verified?.status === 'locked') {
      throw authError('resource-exhausted', 'Too many incorrect code attempts.', 'attempts-exhausted');
    }
    if (Number.isSafeInteger(verified?.expiresAt) && verified.expiresAt <= Date.now()) {
      throw authError('deadline-exceeded', 'Browser sign-in request has expired.', 'expired');
    }
    throw authError('failed-precondition', 'Browser sign-in request is no longer available.', 'unavailable');
  }
  if (verified?.lastAttemptId === attemptId) {
    const exhausted = verified.status === 'locked';
    throw authError(
      exhausted ? 'resource-exhausted' : 'permission-denied',
      exhausted ? 'Too many incorrect code attempts.' : 'The code is incorrect.',
      exhausted ? 'attempts-exhausted' : 'invalid-code',
    );
  }
  if (verified?.status !== 'consumed' || verified.consumedAttemptId !== attemptId) {
    throw authError('failed-precondition', 'Browser sign-in request is no longer available.', 'unavailable');
  }

  const issuedTo = telegramId(verified.issuedTo);
  const [adminSnapshot, userSnapshot] = await Promise.all([
    database().ref(`admins/${issuedTo}`).get(),
    database().ref(`users/${issuedTo}`).get(),
  ]);
  if (!adminSnapshot.exists()) {
    throw authError('permission-denied', 'Administrator access has been revoked.', 'admin-revoked');
  }

  try {
    const token = await getAuth().createCustomToken(issuedTo, { admin: true });
    const profile = userSnapshot.val() || {};
    return {
      status: 'approved',
      token,
      user: {
        id: Number(issuedTo),
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

exports.browserOtpPepper = browserOtpPepper;
exports.cleanupBrowserAuth = cleanupBrowserAuth;
