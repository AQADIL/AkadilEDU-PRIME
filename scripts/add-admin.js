const { db, transactionLoaded } = require('../bot/firebase');

async function bootstrapAdmin() {
  const telegramId = process.env.ADMIN_BOOTSTRAP_TELEGRAM_ID;
  if (!/^\d{1,16}$/.test(telegramId || '') || !Number.isSafeInteger(Number(telegramId)) || Number(telegramId) <= 0) {
    throw new Error('ADMIN_BOOTSTRAP_TELEGRAM_ID must be a valid Telegram user ID');
  }

  const now = Date.now();
  const result = await transactionLoaded(db.ref('admins'), (current) => {
    if (current && Object.keys(current).length > 0) {
      return;
    }
    return { [telegramId]: { role: 'super_admin', createdAt: now } };
  });

  if (!result.committed) {
    throw new Error('Admin bootstrap is only available when no administrator exists');
  }
}

bootstrapAdmin().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
