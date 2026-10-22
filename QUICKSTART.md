# Authorized setup

These instructions are for the owner and expressly authorized operators. See [LICENSE](LICENSE) before using the source. The product overview is in [README.md](README.md).

## 1. Install and configure

Use Node.js 22.12 or newer in the Node.js 22 line. Install each component's locked dependencies:

```powershell
npm --prefix bot ci
npm --prefix functions ci
npm --prefix admin-mini-app ci
npm --prefix question-studio ci
```

Copy `.env.example`, `functions/.env.example` and `admin-mini-app/.env.example` to their corresponding `.env` files. Configure Studio separately using [its setup guide](question-studio/README.md).

- Set the actual bot identity, HTTPS deep-link base, Mini App address and Firebase project values.
- For local Firebase Admin access, set `GOOGLE_APPLICATION_CREDENTIALS` to a credential file outside version control, or configure Application Default Credentials. Deployed Functions use the runtime identity.
- In Functions, use `RTDB_URL` and `DEPLOY_REGION`. The browser's `VITE_FIREBASE_FUNCTIONS_REGION` must match the deployed region.
- Set `SCHEDULER_CRON` to check campaigns every minute. Individual campaign times and time zones are managed in the admin interface.
- Set all authentication lifetime and rate-limit values listed in the templates. Browser OTP attempts are bounded by `BROWSER_AUTH_OTP_MAX_ATTEMPTS`.

## 2. Prepare Firebase identity and secrets

Initialize Firebase Authentication for custom-token sign-in and authorize the admin application's domains. Administrator access uses Telegram identity; email or anonymous sign-in is not required.

For deployed Functions, set the following secrets in the intended project:

```powershell
firebase functions:secrets:set BOT_TOKEN --project $env:FIREBASE_PROJECT_ID
firebase functions:secrets:set TELEGRAM_WEBHOOK_SECRET --project $env:FIREBASE_PROJECT_ID
firebase functions:secrets:set BROWSER_AUTH_OTP_PEPPER --project $env:FIREBASE_PROJECT_ID
```

Use a random OTP pepper containing at least 32 bytes of entropy. Keep these secrets out of `functions/.env`. The local bot's root `.env` needs matching webhook and OTP secrets when those features are used.

The deployed runtime identity must be able to sign Firebase custom tokens. Configure the required `iam.serviceAccounts.signBlob` permission, using `roles/iam.serviceAccountTokenCreator` on its own service account where appropriate for the selected deployment identity.

## 3. Bootstrap the first administrator

For a database without administrators, put your Telegram user ID in `ADMIN_BOOTSTRAP_TELEGRAM_ID` and run:

```powershell
node scripts/add-admin.js
```

This privileged script refuses to modify an existing administrator collection. Keep database rules closed; do not grant public write access to bootstrap an account.

## 4. Check and deploy

```powershell
npm --prefix admin-mini-app run lint
npm --prefix admin-mini-app run build
npm --prefix question-studio run check
npm --prefix question-studio run cloud:check
firebase deploy --only database,storage,functions,hosting --project $env:FIREBASE_PROJECT_ID
```

The Firebase CLI reads the target project ID from the PowerShell environment in these commands; set it explicitly before running them. The Functions predeploy hook packages the current `bot/` source automatically. Build the admin application before deploying: Hosting serves `admin-mini-app/dist` and has no build hook.

## 5. Connect Telegram

Set the root `.env` value `TELEGRAM_WEBHOOK_URL` to the deployed `telegramWebhook` function, then register it:

```powershell
npm --prefix bot run webhook:register
```

Add the bot to the destination channel as an administrator with posting rights. Open `/admin` in the bot, or sign in through the configured admin browser URL with the Telegram-delivered code. Use **Stay logged in** if persistent browser access is wanted.

## 6. Enable a real campaign

Create or publish valid questions, then configure the channel, language, time zone, start time and question timing in **Campaigns**. Verify channel permissions and enable the campaign. Without an enabled campaign and suitable published questions, nothing is automatically posted.

For development without an active Telegram webhook, `npm --prefix bot start` uses polling. The admin development server starts with `npm --prefix admin-mini-app run dev`; Studio uses its own explicitly configured loopback host, port and public origin.

For generation on Google Apps Script, follow the [cloud worker guide](question-studio/cloud/README.md). Pause and migrate the complete accounting state before switching execution ownership. Never run local and cloud generation against separate copies of the same ledger.
