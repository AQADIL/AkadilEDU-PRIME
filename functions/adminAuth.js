const { createHmac, timingSafeEqual } = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');
const logger = require('firebase-functions/logger');

const region = process.env.DEPLOY_REGION;
if (!region) {
  throw new Error('DEPLOY_REGION is required to register adminAuth.');
}

function parseVerifiedInitData(initData, botToken, maxAgeSeconds) {
  if (typeof initData !== 'string' || !initData || initData.length > 16384) {
    throw new HttpsError('invalid-argument', 'Valid Telegram initData is required.');
  }

  const params = new URLSearchParams(initData);
  const fields = [...params.entries()];
  if (new Set(fields.map(([key]) => key)).size !== fields.length) {
    throw new HttpsError('unauthenticated', 'Telegram initData contains duplicate fields.');
  }

  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw new HttpsError('unauthenticated', 'Telegram initData has no valid hash.');
  }

  const checkString = fields
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(checkString).digest();
  if (!timingSafeEqual(expectedHash, Buffer.from(receivedHash, 'hex'))) {
    throw new HttpsError('unauthenticated', 'Telegram initData signature is invalid.');
  }

  const authDateText = params.get('auth_date');
  const authDate = Number(authDateText);
  const now = Math.floor(Date.now() / 1000);
  if (!authDateText || !/^\d+$/.test(authDateText) || !Number.isSafeInteger(authDate)
    || authDate > now || now - authDate > maxAgeSeconds) {
    throw new HttpsError('unauthenticated', 'Telegram initData has expired.');
  }

  let telegramUser;
  try {
    telegramUser = JSON.parse(params.get('user'));
  } catch {
    throw new HttpsError('unauthenticated', 'Telegram user is invalid.');
  }

  if (!telegramUser || !Number.isSafeInteger(telegramUser.id) || telegramUser.id <= 0) {
    throw new HttpsError('unauthenticated', 'Telegram user is invalid.');
  }

  return telegramUser;
}

exports.adminAuth = onCall({ region, secrets: ['BOT_TOKEN'] }, async request => {
  const botToken = process.env.BOT_TOKEN;
  const databaseURL = process.env.RTDB_URL;
  const maxAgeSeconds = Number(process.env.ADMIN_INIT_DATA_MAX_AGE_SECONDS);
  if (!botToken || !databaseURL || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new HttpsError('failed-precondition', 'Admin authentication is not configured.');
  }

  const telegramUser = parseVerifiedInitData(request.data?.initData, botToken, maxAgeSeconds);

  try {
    if (getApps().length === 0) {
      initializeApp({ databaseURL });
    }

    const telegramId = String(telegramUser.id);
    const snapshot = await getDatabase().ref(`admins/${telegramId}`).get();
    if (!snapshot.exists()) {
      throw new HttpsError('permission-denied', 'Administrator access denied.');
    }

    const token = await getAuth().createCustomToken(telegramId, { admin: true });
    return {
      token,
      user: {
        id: telegramUser.id,
        firstName: typeof telegramUser.first_name === 'string' ? telegramUser.first_name : '',
        lastName: typeof telegramUser.last_name === 'string' ? telegramUser.last_name : '',
        username: typeof telegramUser.username === 'string' ? telegramUser.username : '',
        languageCode: typeof telegramUser.language_code === 'string' ? telegramUser.language_code : '',
      },
    };
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    logger.error('Administrator authentication failed', {
      code: typeof error.code === 'string' ? error.code : undefined,
      detail: typeof error.message === 'string' ? error.message : 'Unknown error'
    });
    throw new HttpsError('internal', 'Administrator authentication failed.');
  }
});
