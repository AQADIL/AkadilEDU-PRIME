const path = require('node:path');
const { Api } = require('grammy');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

async function registerWebhook() {
  const token = process.env.BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const rawUrl = process.env.TELEGRAM_WEBHOOK_URL;
  if (!token || !rawUrl || !secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error('BOT_TOKEN, TELEGRAM_WEBHOOK_URL and a valid TELEGRAM_WEBHOOK_SECRET are required');
  }
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('TELEGRAM_WEBHOOK_URL must be a public HTTPS URL');
  }
  await new Api(token).setWebhook(url.toString(), {
    secret_token: secret,
    allowed_updates: ['message', 'callback_query']
  });
}

registerWebhook().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
