import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(root, '.env'), quiet: true });
if (process.env.STUDIO_ENV_FILE) loadEnv({ path: process.env.STUDIO_ENV_FILE, quiet: true });
const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const output = path.join(root, '.cloud-build');
await mkdir(output, { recursive: true });
const functions = ['doGet', 'studioRequest', 'bootstrapCloud', 'activateCloud', 'cloudTick', 'cloudStatus', 'configureCloudRuntime', 'handoffToLocal', 'acceptLocalHandoff'];
await build({ entryPoints: [path.join(root, 'cloud/entry.ts')], outfile: path.join(output, 'Code.js'),
  bundle: true, format: 'iife', globalName: 'AkadilCloud', platform: 'neutral', target: 'es2020', mainFields: ['module', 'main'],
  minify: true, legalComments: 'none',
  define: { DEPLOYMENT_CLOUD_DAILY_RUNTIME_MS: JSON.stringify(required('STUDIO_CLOUD_DAILY_RUNTIME_MS')) },
  footer: { js: functions.map(name => `function ${name}(){return AkadilCloud.${name}.apply(null,arguments);}`).join('\n') },
});
const ui = await build({ entryPoints: [path.join(root, 'public/app.js')], bundle: true, format: 'iife',
  platform: 'browser', target: 'es2020', minify: true, write: false, legalComments: 'none' });
const katexRoot = path.join(root, 'node_modules/katex/dist');
let katexCss = await readFile(path.join(katexRoot, 'katex.min.css'), 'utf8');
const fontUrls = [...new Set([...katexCss.matchAll(/url\((fonts\/[^)]+)\)/g)].map(match => match[1]))];
for (const font of fontUrls) {
  const content = await readFile(path.join(katexRoot, font));
  katexCss = katexCss.replaceAll(`url(${font})`, `url(data:font/${path.extname(font).slice(1)};base64,${content.toString('base64')})`);
}
const css = await readFile(path.join(root, 'public/style.css'), 'utf8');
const katex = await readFile(path.join(katexRoot, 'katex.min.js'), 'utf8');
const autoRender = await readFile(path.join(katexRoot, 'contrib/auto-render.min.js'), 'utf8');
const scriptTag = content => `<script>${content.replace(/<\/script/gi, '<\\/script')}</script>`;
await writeFile(path.join(output, 'Index.html'), `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="color-scheme" content="dark"><base target="_top"><style>${css}\n${katexCss}</style></head><body><a class="skip-link" href="#workspace">К рабочей области</a><div id="app"></div>${scriptTag(katex)}${scriptTag(autoRender)}${scriptTag(ui.outputFiles[0].text)}</body></html>`, 'utf8');
await writeFile(path.join(output, 'appsscript.json'), JSON.stringify({
  timeZone: required('STUDIO_CLOUD_TIMEZONE'), runtimeVersion: 'V8', exceptionLogging: 'STACKDRIVER',
  oauthScopes: required('STUDIO_CLOUD_OAUTH_SCOPES').split(/\s+/),
  dependencies: { enabledAdvancedServices: [{ userSymbol: 'Slides', serviceId: 'slides', version: 'v1' }] },
  webapp: { executeAs: 'USER_ACCESSING', access: 'MYSELF' },
}, null, 2));

if (process.argv.includes('--bootstrap')) {
  const snapshot = JSON.parse(await readFile(path.resolve(root, required('STUDIO_DATA_DIR'), 'state.json'), 'utf8'));
  if (snapshot.status === 'running') throw new Error('Pause the local worker before preparing migration');
  if (snapshot.calls.some(call => ['reserved', 'uncertain'].includes(call.status))) throw new Error('Reconcile uncertain calls first');
  const keys = Object.keys(process.env).filter(key => /^(STUDIO_|OPENAI_|FIREBASE_|GOOGLE_)/.test(key)
    && !['STUDIO_ENV_FILE', 'GOOGLE_APPLICATION_CREDENTIALS'].includes(key));
  const properties = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  properties.FIREBASE_SERVICE_ACCOUNT_JSON = await readFile(required('GOOGLE_APPLICATION_CREDENTIALS'), 'utf8');
  for (const [key, value] of Object.entries(properties)) {
    if (Buffer.byteLength(value) > 9000) throw new Error(`Script property ${key} exceeds Google's limit`);
  }
  const payload = Buffer.from(JSON.stringify({ properties, state: snapshot })).toString('base64');
  await writeFile(path.join(output, 'Bootstrap.html'), payload, { mode: 0o600 });
}
