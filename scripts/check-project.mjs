import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenPaths = [
  /(?:^|\/)\.env(?:\.|$)(?!example$)/,
  /(?:^|\/)(?:node_modules|dist|build|coverage|\.data|\.cloud-build|\.firebase|\.playwright-cli)(?:\/|$)/,
  /^functions\/bot(?:\/|$)/,
  /(?:^|\/)(?:\.clasp(?:rc)?\.json|\.clasprc\.json|gha-creds-[^/]+\.json)$/,
  /(?:^|\/)(?:service-account[^/]*|[^/]*serviceAccount[^/]*|[^/]*-firebase-adminsdk-[^/]*)\.json$/i,
  /\.(?:pem|p12|key|log|tmp|tsbuildinfo)$/i,
];
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\bsk-(?:proj-|svcacct-)[A-Za-z0-9_-]{25,}\b/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/,
];
const problems = [];
const jsonFiles = new Map();
const markdownFiles = new Map();
let checkedJavaScript = 0;

function report(file, message) {
  problems.push(`${file}: ${message}`);
}

function normalizedEntries(value) {
  return Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

function hostnameDigest(hostname) {
  return createHash('sha256').update(hostname.toLowerCase().replace(/\.$/, '')).digest('hex');
}

function configuredHostDigests() {
  const raw = process.env.PRIVATE_ADMIN_HOST_DIGESTS;
  if (raw === undefined) return new Set();
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('PRIVATE_ADMIN_HOST_DIGESTS must be a JSON array of SHA-256 digests');
  }
  if (!Array.isArray(parsed) || !parsed.length
    || parsed.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error('PRIVATE_ADMIN_HOST_DIGESTS must be a nonempty JSON array of lowercase SHA-256 digests');
  }
  return new Set(parsed);
}

function includesPrivateHostname(text, digests) {
  if (!digests.size) return false;
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s"'`<>(){}\[\]\\]+/gi)) {
    try {
      if (digests.has(hostnameDigest(new URL(match[0]).hostname))) return true;
    } catch { continue; }
  }
  for (const match of text.matchAll(/\b[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.(?:web\.app|firebaseapp\.com)\b/gi)) {
    if (digests.has(hostnameDigest(match[0]))) return true;
  }
  return false;
}

function validateManifest(file, manifest) {
  const lockPath = path.posix.join(path.posix.dirname(file), 'package-lock.json');
  const lock = jsonFiles.get(lockPath);
  if (!lock?.packages?.['']) {
    report(file, 'A matching npm lockfile is required');
    return;
  }
  const locked = lock.packages[''];
  for (const key of ['name', 'version', 'license']) {
    if (manifest[key] !== locked[key]) report(file, `Lockfile ${key} does not match`);
  }
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'engines']) {
    if (JSON.stringify(normalizedEntries(manifest[key])) !== JSON.stringify(normalizedEntries(locked[key]))) {
      report(file, `Lockfile ${key} does not match`);
    }
  }
  if (manifest.private !== true || manifest.license !== 'UNLICENSED') {
    report(file, 'Project packages must be private and UNLICENSED');
  }
}

async function validateLink(file, target) {
  if (/^(?:https?:|mailto:|data:|#)/i.test(target)) return;
  let decoded;
  try { decoded = decodeURIComponent(target.split('#')[0].split('?')[0]); }
  catch { report(file, 'A local documentation link has invalid encoding'); return; }
  if (!decoded) return;
  const absolute = path.resolve(path.dirname(path.join(root, file)), decoded);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    report(file, 'A local documentation link leaves the repository');
    return;
  }
  try { await stat(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    report(file, `Local documentation target is missing: ${decoded}`);
  }
}

async function check() {
  const result = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, maxBuffer: 10 * 1024 * 1024,
  });
  const files = [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
  const privateDigests = configuredHostDigests();
  const privateOrigin = process.env.PRIVATE_ADMIN_ORIGIN?.trim();
  let privateHost;
  if (privateOrigin) {
    const parsed = new URL(privateOrigin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Error('PRIVATE_ADMIN_ORIGIN must be an HTTPS origin without credentials');
    }
    privateHost = parsed.hostname;
  }
  for (const file of files) {
    if (forbiddenPaths.some(pattern => pattern.test(file))) {
      report(file, 'Private configuration or generated output must not be versioned');
      continue;
    }
    const buffer = await readFile(path.join(root, file));
    if (buffer.includes(0)) continue;
    const text = buffer.toString('utf8');
    if (credentialPatterns.some(pattern => pattern.test(text))) {
      report(file, 'A credential pattern was detected; the matched value is withheld');
      continue;
    }
    if ((privateHost && text.toLowerCase().includes(privateHost.toLowerCase()))
      || includesPrivateHostname(text, privateDigests)) {
      report(file, 'The private administrator destination must not be published');
    }
    if (/^(?:<{7}|={7}|>{7})(?: |$)/m.test(text)) report(file, 'An unresolved merge marker was found');
    if (file.endsWith('.json')) {
      try { jsonFiles.set(file, JSON.parse(text)); }
      catch { report(file, 'Invalid JSON'); }
    }
    if (file.endsWith('.md')) markdownFiles.set(file, text);
    if (/\.(?:js|mjs|cjs)$/.test(file)) {
      try {
        await execute(process.execPath, ['--check', path.join(root, file)], { cwd: root });
        checkedJavaScript++;
      } catch { report(file, 'JavaScript syntax validation failed'); }
    }
  }
  for (const [file, manifest] of jsonFiles) {
    if (file.endsWith('/package.json') || file === 'package.json') validateManifest(file, manifest);
  }
  for (const [file, markdown] of markdownFiles) {
    const content = markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
    const targets = new Set([
      ...[...content.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)].map(match => match[1] ?? match[2]),
      ...[...content.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]),
    ]);
    for (const target of targets) await validateLink(file, target);
  }
  if (problems.length) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Project checks passed: ${files.length} files, ${checkedJavaScript} JavaScript sources, ${markdownFiles.size} documentation files.\n`);
}

check().catch(() => {
  process.stderr.write('Project checks could not finish. Check repository availability, file access and environment configuration.\n');
  process.exitCode = 1;
});
