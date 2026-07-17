#!/usr/bin/env node
/**
 * AgenTel beta.9 — TRUE one-command bootstrap (ADR 0029).
 *
 *     node scripts/agentel.mjs verify
 *
 * From a FRESH clone with ONLY an unsupported Node (e.g. global Node 25) on PATH, this:
 *   1. runs under any Node WITHOUT the product runtime floor (it is a bootstrapper, not the CLI);
 *   2. locates a COMPLETE approved Node 22/24 dist (env override → repo-vendored `.agentel/node`);
 *   3. if absent, DOWNLOADS the pinned official Node Windows ZIP into `.agentel/cache`, verifies it
 *      against the committed SHA-256 pin (scripts/agentel-runtime-pins.json), and extracts it
 *      atomically into `.agentel/node` — under a lock, recovering from any interrupted attempt;
 *   4. verifies node.exe + npm.cmd + npx.cmd + npm-cli.js are all present (a COMPLETE dist);
 *   5. runs `npm ci` through the provisioned runtime, builds `dist/`;
 *   6. re-execs the REAL `agentel verify` (dist/cli/main.js) under that runtime and forwards args.
 *
 * Guarantees: no admin rights / NVM / PATH edit / manual download required; NEVER executes an
 * unverified download; writes ONLY under `.agentel/` (+ OS temp); leaves tracked files clean;
 * concurrency-safe (lock); resumable (partial download/extract discarded + retried); honors
 * AGENTEL_VERIFY_NODE + a pre-vendored `.agentel/node` for offline/corporate use; fails closed with
 * exact proxy/TLS/download remediation.
 *
 * Node built-ins ONLY. Does NOT import anything from dist/ or TypeScript source (a fresh clone has
 * no dist/). ESM .mjs so it runs directly under any modern Node.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const AGENTEL_DIR = path.join(REPO, '.agentel');
const CACHE_DIR = path.join(AGENTEL_DIR, 'cache');
const RUNTIME_DIR = path.join(AGENTEL_DIR, 'node');           // resolver rung-2 location
const LOCK_DIR = path.join(AGENTEL_DIR, 'bootstrap.lock');    // mkdir-based lock (atomic on Windows)
const PINS_FILE = path.join(HERE, 'agentel-runtime-pins.json');

const argv = process.argv.slice(2);
const log = (s) => process.stdout.write(`[agentel-bootstrap] ${s}\n`);
const die = (s, code = 1) => { process.stderr.write(`[agentel-bootstrap] FATAL: ${s}\n`); process.exit(code); };
const isWin = process.platform === 'win32';

/** node/npm/npx file names for the platform (Windows dist ships .cmd shims next to node.exe). */
function runtimeFiles(dir) {
  return isWin
    ? { node: path.join(dir, 'node.exe'), npmCmd: path.join(dir, 'npm.cmd'), npxCmd: path.join(dir, 'npx.cmd') }
    : { node: path.join(dir, 'bin', 'node'), npmCmd: path.join(dir, 'bin', 'npm'), npxCmd: path.join(dir, 'bin', 'npx') };
}
/** npm-cli.js reachable from a node binary (all platforms ship it in the dist's node_modules). */
function findNpmCli(nodeBin) {
  const dir = path.dirname(nodeBin);
  const cands = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),         // Windows dist
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX dist
    path.join(dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of cands) { const n = path.normalize(c); if (isFile(n)) return n; }
  return null;
}
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** Parse "vMAJOR.MINOR.PATCH" → {major,minor}; supported floor is [22.13, 25). */
function inFloor(versionString) {
  const m = /^v?(\d+)\.(\d+)\./.exec(versionString || '');
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  const tooOld = major < 22 || (major === 22 && minor < 13);
  const tooNew = major >= 25;
  return !tooOld && !tooNew;
}
/** Ask a node binary its version (spawns `<node> --version`), or null. */
function nodeVersionOf(nodeBin) {
  try {
    const r = spawnSync(nodeBin, ['--version'], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) return null;
    const v = (r.stdout || '').trim();
    return /^v\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch { return null; }
}

/** A COMPLETE approved runtime at `dir` = node+npm+npx shims + npm-cli.js present AND in-floor. */
function inspectRuntime(dir) {
  const f = runtimeFiles(dir);
  if (!isFile(f.node) || !isFile(f.npmCmd) || !isFile(f.npxCmd)) return { ok: false, reason: 'incomplete (missing node/npm/npx)' };
  const npmCli = findNpmCli(f.node);
  if (!npmCli) return { ok: false, reason: 'npm-cli.js not found in dist' };
  const version = nodeVersionOf(f.node);
  if (!version) return { ok: false, reason: 'could not read node --version' };
  if (!inFloor(version)) return { ok: false, reason: `${version} is outside the supported floor [22.13, 25)` };
  return { ok: true, node: f.node, npmCli, version, dir };
}

function readPins() {
  try { return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')); }
  catch (e) { die(`cannot read runtime pins at ${PINS_FILE}: ${e.message}`); }
}
/** Choose the pin for this platform/arch (defaults to the pinned defaultVersion). */
function selectPin(pins) {
  const arch = process.arch;
  const match = pins.runtimes.find((r) => r.platform === process.platform && r.arch === arch && r.version === pins.defaultVersion)
    || pins.runtimes.find((r) => r.platform === process.platform && r.arch === arch);
  if (!match) die(`no pinned Node runtime for ${process.platform}/${arch} in ${PINS_FILE}. Add a pin, or set AGENTEL_VERIFY_NODE / pre-vendor a complete dist into ${RUNTIME_DIR}.`);
  return match;
}

function sha256File(p) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

/** mkdir-based lock (mkdir is atomic + fails if exists). Stale-lock recovery after `staleMs`. */
function acquireLock(staleMs = 20 * 60_000) {
  fs.mkdirSync(AGENTEL_DIR, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { fs.mkdirSync(LOCK_DIR); fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid)); return; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Lock held. Break a stale lock (older than staleMs) so an interrupted run cannot wedge us.
      let age = 0; try { age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs; } catch { /* gone → retry */ }
      if (age > staleMs) { try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* */ } continue; }
      if (attempt === 0) log('another bootstrap holds the lock; waiting…');
      // Busy-wait a bounded time (synchronous by design — this is a CLI bootstrap).
      const until = Date.now() + 1500; while (Date.now() < until) { /* spin */ }
      if (attempt > 800) die(`could not acquire bootstrap lock at ${LOCK_DIR} (held > ~20 min). If no other bootstrap is running, delete it and retry.`);
    }
  }
}
function releaseLock() { try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* */ } }

/** The three supported ways to provision WITHOUT a working network — named in every download
 *  failure so the remediation is actionable, never a raw stack. */
function offlineRemediation() {
  return [
    'Supported alternatives (no network / behind a proxy):',
    `  1. Place the pinned verified ZIP under ${CACHE_DIR} (its SHA-256 is re-checked before use).`,
    `  2. Pre-vendor a complete Node 22/24 runtime under ${RUNTIME_DIR} (node + npm/npx + npm-cli.js).`,
    '  3. Set AGENTEL_VERIFY_NODE to a complete approved Node 22/24 distribution.',
  ].join('\n');
}

/** Turn a raw download/socket/TLS error into a concise, fail-closed, actionable message. Covers
 *  ECONNRESET / ECONNREFUSED / ETIMEDOUT / socket hang up / TLS-certificate / proxy classes. Never
 *  disables TLS, bypasses the SHA, or executes anything — it only explains the offline alternatives. */
function classifyDownloadError(err, url) {
  const code = err && err.code ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : String(err);
  const both = `${code} ${msg}`;
  let cause;
  if (code === 'ECONNRESET' || /socket hang ?up/i.test(both)) cause = 'the connection was reset (ECONNRESET / socket hang up) — often a proxy or network appliance dropping the connection';
  else if (code === 'ECONNREFUSED') cause = 'the connection was refused (ECONNREFUSED) — the host/port is unreachable from this network';
  else if (code === 'ETIMEDOUT' || /TIMEOUT/i.test(both)) cause = 'the connection timed out (ETIMEDOUT) — the network is slow/blocked or a proxy is required';
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') cause = 'DNS resolution failed (ENOTFOUND/EAI_AGAIN) — no network or a proxy-only environment';
  else if (/self.signed|unable to (verify|get)|CERT_|DEPTH_ZERO|ERR_TLS|certificate/i.test(both)) cause = 'a TLS/certificate error — a corporate TLS-inspection proxy is likely intercepting the connection (AgenTel will NOT disable TLS verification)';
  else if (/PROXY_UNSUPPORTED/.test(both)) return err.message; // already a full remediation message
  else cause = `${code ? code + ': ' : ''}${msg}`;
  return `Could not download the pinned Node runtime from ${url}: ${cause}.\n${offlineRemediation()}`;
}

/** Download url → dest with redirects + timeout. Writes to dest.part then renames (atomic). */
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const part = dest + '.part';
    try { fs.rmSync(part, { force: true }); } catch { /* */ }
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    // Built-in https has no proxy support; if a proxy is set we cannot honor it without a dep —
    // fail closed with exact remediation rather than silently bypassing a corporate proxy.
    if (proxy) return reject(new Error(`PROXY_UNSUPPORTED: HTTPS_PROXY is set (${proxy}) but the built-in downloader cannot traverse a proxy.\n${offlineRemediation()}`));
    const req = https.get(url, { timeout: 60_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`)); }
      const out = fs.createWriteStream(part);
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => out.close(() => { try { fs.renameSync(part, dest); resolve(); } catch (e) { reject(e); } }));
    });
    req.on('timeout', () => { const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; req.destroy(e); });
    req.on('error', (e) => { reject(new Error(classifyDownloadError(e, url))); });
  });
}

/**
 * Extract an official Node Windows ZIP (STORE + DEFLATE) whose entries live under a single
 * top dir (dirInArchive) into `destDir` (stripping that top dir). Pure Node (zlib). Extracts
 * into a temp sibling then atomically renames into place, so a partial extraction never leaves a
 * half-written RUNTIME_DIR.
 */
function extractNodeZip(zipPath, destDir, dirInArchive) {
  const buf = fs.readFileSync(zipPath);
  // Locate End Of Central Directory.
  let p = buf.length - 22;
  while (p >= 0 && buf.readUInt32LE(p) !== 0x06054b50) p--;
  if (p < 0) throw new Error('not a valid ZIP (no EOCD)');
  const count = buf.readUInt16LE(p + 10);
  let o = buf.readUInt32LE(p + 16);
  const staging = destDir + '.tmp-' + process.pid;
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* */ }
  fs.mkdirSync(staging, { recursive: true });
  const prefix = dirInArchive.endsWith('/') ? dirInArchive : dirInArchive + '/';
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(o + 10);
    const csize = buf.readUInt32LE(o + 20);
    const nameLen = buf.readUInt16LE(o + 28);
    const extraLen = buf.readUInt16LE(o + 30);
    const cmtLen = buf.readUInt16LE(o + 32);
    const lho = buf.readUInt32LE(o + 42);
    const name = buf.toString('utf8', o + 46, o + 46 + nameLen);
    o += 46 + nameLen + extraLen + cmtLen;
    if (!name.startsWith(prefix)) continue;            // ignore anything outside the expected top dir
    const rel = name.slice(prefix.length);
    if (!rel) continue;
    // Zip-slip guard: the normalized target must stay inside staging.
    const target = path.join(staging, rel);
    if (!path.resolve(target).startsWith(path.resolve(staging) + path.sep) && path.resolve(target) !== path.resolve(staging)) {
      throw new Error(`unsafe entry escapes extraction root: ${name}`);
    }
    if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    // Local header → data offset.
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtra = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtra;
    const comp = buf.subarray(dataStart, dataStart + csize);
    const data = method === 0 ? comp : zlib.inflateRawSync(comp);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  // Atomic swap into place: remove any prior/partial RUNTIME_DIR, then rename staging → destDir.
  try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* */ }
  fs.renameSync(staging, destDir);
}

/** Provision a complete approved runtime into RUNTIME_DIR (download+verify+extract). Returns inspect. */
function provisionRuntime() {
  const pins = readPins();
  const pin = selectPin(pins);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const zipPath = path.join(CACHE_DIR, pin.archive);

  // Use a cached ZIP if present AND its bytes match the pin (offline / second-run path). A
  // present-but-mismatching cached ZIP (corrupted/partial/tampered) is discarded, never trusted.
  let haveValidZip = false;
  if (isFile(zipPath)) {
    const got = sha256File(zipPath);
    if (got === pin.sha256) { haveValidZip = true; log(`using cached verified ZIP (${pin.archive})`); }
    else { log(`cached ZIP failed SHA-256 (got ${got.slice(0, 12)}…, want ${pin.sha256.slice(0, 12)}…) — discarding`); fs.rmSync(zipPath, { force: true }); }
  }

  if (!haveValidZip) {
    log(`downloading pinned Node ${pin.version} (${pin.archive}) → ${CACHE_DIR}`);
    try { /* sync-await via a tiny loop is unavailable; provisionRuntime is called from an async main */ }
    catch { /* */ }
    return { needsDownload: true, pin, zipPath };
  }
  return finishProvision(pin, zipPath);
}

/** After a verified ZIP is in place, extract + verify the runtime. */
function finishProvision(pin, zipPath) {
  // Final safety: re-verify the ZIP bytes immediately before extraction (never extract unverified).
  const got = sha256File(zipPath);
  if (got !== pin.sha256) die(`ZIP SHA-256 mismatch before extraction (got ${got}, want ${pin.sha256}). Refusing to extract an unverified archive.`);
  log(`ZIP verified (sha256 ${got.slice(0, 16)}…); extracting → ${RUNTIME_DIR}`);
  extractNodeZip(zipPath, RUNTIME_DIR, pin.dirInArchive);
  const insp = inspectRuntime(RUNTIME_DIR);
  if (!insp.ok) die(`provisioned runtime is not complete/approved after extraction: ${insp.reason}`);
  log(`provisioned complete runtime: ${insp.version} at ${RUNTIME_DIR}`);
  return insp;
}

/** Resolve an approved runtime: env override → vendored .agentel/node → provision. */
async function resolveOrProvision() {
  // 1) Explicit override (offline/corporate): AGENTEL_VERIFY_NODE / XBUS_VERIFY_NODE → a node binary.
  const envNode = process.env.AGENTEL_VERIFY_NODE || process.env.XBUS_VERIFY_NODE;
  if (envNode) {
    const dir = isWin ? path.dirname(envNode) : path.dirname(path.dirname(envNode));
    const insp = inspectRuntime(dir);
    if (insp.ok) { log(`using AGENTEL_VERIFY_NODE runtime: ${insp.version} (${envNode})`); return insp; }
    // If the override points at a bare complete dist dir, try that dir directly.
    const insp2 = inspectRuntime(path.dirname(envNode));
    if (insp2.ok) { log(`using AGENTEL_VERIFY_NODE runtime dir: ${insp2.version}`); return insp2; }
    die(`AGENTEL_VERIFY_NODE=${envNode} is not a complete approved runtime: ${insp.reason}`);
  }
  // 2) Pre-vendored complete dist (offline preseed): .agentel/node already populated.
  if (isDir(RUNTIME_DIR)) {
    const insp = inspectRuntime(RUNTIME_DIR);
    if (insp.ok) { log(`using pre-vendored runtime: ${insp.version} at ${RUNTIME_DIR}`); return insp; }
    log(`pre-vendored ${RUNTIME_DIR} is not complete/approved (${insp.reason}) — will (re)provision`);
  }
  // 3) Provision (download+verify+extract), under a lock, with recovery.
  acquireLock();
  try {
    // Re-check after acquiring the lock (another process may have just provisioned it).
    if (isDir(RUNTIME_DIR)) { const insp = inspectRuntime(RUNTIME_DIR); if (insp.ok) { log(`runtime provisioned by a concurrent bootstrap: ${insp.version}`); return insp; } }
    const first = provisionRuntime();
    if (first.needsDownload) {
      await download(first.pin.url, first.zipPath);
      return finishProvision(first.pin, first.zipPath);
    }
    return first;
  } finally { releaseLock(); }
}

/** Spawn a command with the provisioned runtime's dir FIRST on PATH; inherit stdio. */
function run(nodeBin, args, extraEnv = {}) {
  const dir = path.dirname(nodeBin);
  const r = spawnSync(nodeBin, args, {
    cwd: REPO, stdio: 'inherit',
    env: { ...process.env, ...extraEnv, PATH: dir + path.delimiter + (process.env.PATH || '') },
  });
  return r.status ?? 1;
}

async function main() {
  // `--provision-only`: provision (or resolve) the approved runtime and exit — no install/build/verify.
  // Used by the acceptance tests to exercise the provisioning mechanics deterministically + fast.
  // Prints one machine-parseable line: PROVISIONED <version> <nodePath>.
  const provisionOnly = argv.includes('--provision-only');
  const cmd = argv.find((a) => !a.startsWith('-'));
  if (!provisionOnly && cmd !== 'verify' && cmd !== 'release-check' && cmd !== 'govern') {
    // Bootstrap is meant for the runtime-resolving commands. For anything else, tell the user to
    // use the built CLI directly (which they can only do after a build).
    process.stderr.write('Usage: node scripts/agentel.mjs <verify|release-check|govern> [args]\n');
    process.stderr.write('This bootstrap provisions an approved Node runtime, installs, builds, then runs the command.\n');
    process.exit(2);
  }

  log(`bootstrap running under ${process.version} (floor NOT applied to the bootstrapper)`);
  const rt = await resolveOrProvision();
  const nodeBin = rt.node;

  if (provisionOnly) {
    // Assert completeness one more time before declaring success (never claim an incomplete runtime).
    const insp = inspectRuntime(rt.dir);
    if (!insp.ok) die(`runtime incomplete after provisioning: ${insp.reason}`);
    log(`PROVISIONED ${rt.version} ${nodeBin}`);
    process.exit(0);
  }

  // Install deps on the provisioned runtime (fresh clone has no node_modules). `npm ci` needs a
  // lockfile; fall back to `npm install` if somehow absent.
  const hasLock = isFile(path.join(REPO, 'package-lock.json'));
  log(`npm ${hasLock ? 'ci' : 'install'} on the provisioned runtime…`);
  let code = run(nodeBin, [rt.npmCli, hasLock ? 'ci' : 'install']);
  if (code !== 0) die(`npm ${hasLock ? 'ci' : 'install'} failed (exit ${code}). If this is a network/proxy failure, pre-vendor a complete Node dist into ${RUNTIME_DIR} and retry offline.`, code);

  // Build dist/ (fresh clone has no dist/).
  log('npm run build on the provisioned runtime…');
  code = run(nodeBin, [rt.npmCli, 'run', 'build']);
  if (code !== 0) die(`build failed (exit ${code}).`, code);

  // Re-exec the REAL agentel command under the provisioned runtime. Pin AGENTEL_VERIFY_NODE so the
  // downstream `agentel verify` resolver reuses THIS runtime rather than re-resolving/re-provisioning.
  const cli = path.join(REPO, 'dist', 'cli', 'main.js');
  if (!isFile(cli)) die(`build did not produce ${cli}`);
  log(`re-exec: agentel ${argv.join(' ')} under ${rt.version}`);
  code = run(nodeBin, [cli, ...argv], { AGENTEL_VERIFY_NODE: nodeBin });
  process.exit(code);
}

// Exported for unit tests (classification is pure). The bootstrap only RUNS when invoked directly
// as a script (process.argv[1] is this file), not when imported by a test.
export { classifyDownloadError, offlineRemediation };

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    releaseLock();
    // Download/provision failures already carry a concise, actionable remediation as their message
    // (see classifyDownloadError). Print the MESSAGE, not a raw stack. Fall back to the stack only for
    // genuinely unexpected errors that lack a message.
    die(e && e.message ? e.message : (e && e.stack ? e.stack : String(e)));
  });
}
