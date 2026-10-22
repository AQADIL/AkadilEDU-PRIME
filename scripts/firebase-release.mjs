import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sensitiveValues = new Set();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hide(value) {
  if (!value || sensitiveValues.has(value)) return;
  sensitiveValues.add(value);
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}\n`);
  }
}

function secureUrl(value, name) {
  hide(value);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid URL`); }
  hide(parsed.hostname);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${name} must use HTTPS without credentials or a fragment`);
  }
  return parsed;
}

async function configuration(name, template) {
  let values;
  try { values = JSON.parse(required(name)); } catch { throw new Error(`${name} must contain a JSON object`); }
  if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error(`${name} must contain a JSON object`);
  const text = await readFile(path.join(root, template), 'utf8');
  const allowed = new Set([...text.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map(match => match[1]));
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      throw new Error(`Invalid configuration field in ${name}`);
    }
    if (value.startsWith('https:')) secureUrl(value, key);
  }
  for (const key of allowed) {
    if (key !== 'VITE_FIREBASE_MEASUREMENT_ID' && !values[key]?.trim()) throw new Error(`${name} is missing ${key}`);
  }
  return values;
}

async function writeEnvironment(relative, values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n');
  await writeFile(path.join(root, relative), `${text}\n`, { mode: 0o600 });
}

async function prepare() {
  const project = required('FIREBASE_PROJECT_ID');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error('Invalid Firebase project identifier');
  hide(`${project}.web.app`);
  hide(`${project}.firebaseapp.com`);
  const origin = secureUrl(required('FIREBASE_HOSTING_ORIGIN'), 'FIREBASE_HOSTING_ORIGIN');
  if (origin.pathname !== '/' || origin.search) throw new Error('Hosting configuration must contain an origin only');
  const web = await configuration('FIREBASE_WEB_CONFIG', 'admin-mini-app/.env.example');
  const functions = await configuration('FIREBASE_FUNCTIONS_CONFIG', 'functions/.env.example');
  if (web.VITE_FIREBASE_PROJECT_ID !== project) throw new Error('The browser configuration targets a different project');
  if (web.VITE_FIREBASE_FUNCTIONS_REGION !== functions.DEPLOY_REGION) throw new Error('Browser and Functions regions differ');
  if (secureUrl(web.VITE_FIREBASE_DATABASE_URL, 'Database').href !== secureUrl(functions.RTDB_URL, 'Database').href) {
    throw new Error('Browser and Functions databases differ');
  }
  if (secureUrl(functions.MINI_APP_URL, 'MINI_APP_URL').origin !== origin.origin) {
    throw new Error('The verification origin does not match the application configuration');
  }
  for (const key of ['ADMIN_INIT_DATA_MAX_AGE_SECONDS', 'BROWSER_AUTH_TTL_SECONDS', 'BROWSER_AUTH_RATE_WINDOW_SECONDS',
    'BROWSER_AUTH_RATE_MAX', 'BROWSER_AUTH_OTP_MAX_ATTEMPTS']) {
    if (!/^[1-9]\d*$/.test(functions[key]) || !Number.isSafeInteger(Number(functions[key]))) throw new Error(`Invalid ${key}`);
  }
  if (Number(functions.BROWSER_AUTH_OTP_MAX_ATTEMPTS) > 5) throw new Error('The OTP attempt limit exceeds the server maximum');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/check-project.mjs')], {
      cwd: root, stdio: 'inherit', env: { ...process.env, PRIVATE_ADMIN_ORIGIN: origin.origin },
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Pre-deployment source checks failed')));
  });
  await writeEnvironment('admin-mini-app/.env.production', web);
  await writeEnvironment(`functions/.env.${project}`, functions);
  process.stdout.write('Deployment configuration validated and prepared.\n');
}

async function verify() {
  const origin = secureUrl(required('FIREBASE_HOSTING_ORIGIN'), 'FIREBASE_HOSTING_ORIGIN');
  const expected = await readFile(path.join(root, 'admin-mini-app/dist/index.html'), 'utf8');
  const assets = [...expected.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(match => match[1]);
  if (!assets.length || /%VITE_[A-Z_]+%/.test(expected)) throw new Error('The production build is incomplete');
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(origin, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Hosting verification returned HTTP ${response.status}`);
    const actual = await response.text();
    if (assets.every(asset => actual.includes(asset))) {
      for (const asset of assets) {
        const result = await fetch(new URL(asset, origin), { method: 'HEAD', signal: AbortSignal.timeout(30000) });
        if (!result.ok) throw new Error(`A published build asset returned HTTP ${result.status}`);
      }
      process.stdout.write('Published build and referenced assets verified.\n');
      return;
    }
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error('Hosting is serving a different build');
}

async function main() {
  if (process.argv[2] === 'prepare') await prepare();
  else if (process.argv[2] === 'verify') await verify();
  else throw new Error('Choose prepare or verify');
}

main().catch(error => {
  let message = error instanceof Error ? error.message : 'Release operation failed';
  for (const value of sensitiveValues) message = message.replaceAll(value, '[redacted]');
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
