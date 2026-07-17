#!/usr/bin/env node
/**
 * AgenTel beta.9 — bootstrap acceptance (ADR 0029). Proves the TRUE fresh-clone, one-command
 * bootstrap from a clean copied checkout with NO dist, NO node_modules, empty `.agentel`, and an
 * UNSUPPORTED Node (25) as the launcher — no approved Node elsewhere, no admin assumed.
 *
 * It exercises the provisioning MECHANICS deterministically via `agentel.mjs --provision-only`
 * (fast: provision the runtime + exit, no 15-min gate), across the required scenarios:
 *   1. fresh clone + cached ZIP → provisions a complete approved runtime (offline second-run path)
 *   2. cached second run works with NO network (pins.url pointed at an unreachable host)
 *   3. corrupted ZIP is rejected (bytes flipped)
 *   4. wrong SHA pin is rejected (pin mutated)
 *   5. partial extraction is recovered (a stale .agentel/node from a prior crash is replaced)
 *   6. incomplete runtime fails before it is accepted (npm.cmd removed)
 *   7. explicit AGENTEL_VERIFY_NODE overrides bootstrap (no download/extract at all)
 *   8. repo copy stays clean; provisioning writes ONLY under `.agentel/`
 *
 * A pre-verified official ZIP must be provided (offline) so the tests need no network:
 *   node scripts/accept-bootstrap.mjs --seed-zip <path-to-node-vX-win-x64.zip>
 * (The download PATH itself is proven separately by a real network run — see the release report.)
 *
 * Exits 0 on success (prints AGENTEL_BOOTSTRAP_ACCEPT_PASS), non-zero on any failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const seedIdx = argv.indexOf('--seed-zip');
const seedZip = seedIdx > -1 ? path.resolve(argv[seedIdx + 1]) : path.join(REPO, '.agentel', 'cache', 'node-v22.23.1-win-x64.zip');
const launcher = process.execPath; // whatever Node ran THIS script (the test runs it under Node 25)

const pins = JSON.parse(fs.readFileSync(path.join(HERE, 'agentel-runtime-pins.json'), 'utf8'));
const pin = pins.runtimes.find((r) => r.platform === process.platform && r.arch === process.arch) || pins.runtimes[0];
if (!fs.existsSync(seedZip)) { process.stderr.write(`FAIL: no seed ZIP at ${seedZip}. Pass --seed-zip <official-node-win-x64.zip>.\n`); process.exit(2); }

const log = (s) => process.stdout.write(s + '\n');
let pass = 0, failed = 0;
function check(name, cond, detail = '') { if (cond) { pass++; log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); } else { failed++; log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); } }

/** Build a minimal fresh-clone copy: scripts/ + package.json + package-lock.json + tsconfig + src (for a real build case, opt-in). */
function freshCheckout(withSrc = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentel-fresh-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const f of ['agentel.mjs', 'agentel-runtime-pins.json']) fs.copyFileSync(path.join(HERE, f), path.join(dir, 'scripts', f));
  for (const f of ['package.json', 'package-lock.json', 'tsconfig.json']) { if (fs.existsSync(path.join(REPO, f))) fs.copyFileSync(path.join(REPO, f), path.join(dir, f)); }
  if (withSrc) { fs.cpSync(path.join(REPO, 'src'), path.join(dir, 'src'), { recursive: true }); }
  // Explicitly NO dist/, NO node_modules/, empty (absent) .agentel/.
  return dir;
}
/** Run the bootstrap in `dir` under the (unsupported) launcher Node, provision-only.
 *  The baseline provisioning scenarios (1–6) must NOT inherit an ambient AGENTEL_VERIFY_NODE /
 *  XBUS_VERIFY_NODE — otherwise the bootstrap would resolve that override instead of exercising the
 *  download/extract/cache path, silently invalidating the test. Build a SANITIZED base env that
 *  strips both, so `AGENTEL_VERIFY_NODE=<node> npm run accept:bootstrap` still runs the real
 *  provisioning cases. Scenario 7 explicitly re-adds its own AGENTEL_VERIFY_NODE via `extraEnv` to
 *  prove the override still wins. */
function runProvision(dir, extraEnv = {}, extraArgs = []) {
  const baseEnv = { ...process.env };
  delete baseEnv.AGENTEL_VERIFY_NODE;
  delete baseEnv.XBUS_VERIFY_NODE;
  const r = spawnSync(launcher, [path.join(dir, 'scripts', 'agentel.mjs'), 'verify', '--provision-only', ...extraArgs], {
    cwd: dir, encoding: 'utf8', timeout: 180_000,
    env: { ...baseEnv, ...extraEnv },
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}
function seedCache(dir, { corrupt = false } = {}) {
  const cache = path.join(dir, '.agentel', 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const dest = path.join(cache, pin.archive);
  fs.copyFileSync(seedZip, dest);
  if (corrupt) { const b = fs.readFileSync(dest); b[Math.floor(b.length / 2)] ^= 0xff; fs.writeFileSync(dest, b); }
  return dest;
}
/** node.exe location inside a provisioned runtime (win) for completeness pokes. */
function runtimeNode(dir) { return path.join(dir, '.agentel', 'node', process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node')); }

try {
  log('== AgenTel bootstrap acceptance ==');
  log(`launcher: ${process.version} (unsupported floor expected)   seed: ${seedZip}\n`);
  check('launcher is an UNSUPPORTED Node (proves floor-free bootstrap)', !/^v2[234]\./.test(process.version), process.version);

  // ── 1. Fresh clone + cached verified ZIP → provisions a complete approved runtime.
  { const d = freshCheckout(); seedCache(d);
    const r = runProvision(d);
    check('[1] fresh-clone provision succeeds', r.code === 0 && /PROVISIONED v22/.test(r.out), `exit ${r.code}`);
    const f = runtimeNode(d);
    check('[1] provisioned a COMPLETE runtime (node+npm+npx)', fs.existsSync(f) && fs.existsSync(path.join(d, '.agentel', 'node', 'npm.cmd')) && fs.existsSync(path.join(d, '.agentel', 'node', 'npx.cmd')));
    // repo copy clean of stray files outside .agentel: no dist, no node_modules created by provision-only.
    check('[1] provision-only wrote ONLY under .agentel (no dist/node_modules)', !fs.existsSync(path.join(d, 'dist')) && !fs.existsSync(path.join(d, 'node_modules')));
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ── 2. Cached second run works with NO network (point pins.url at an unreachable host).
  { const d = freshCheckout(); seedCache(d);
    // Mutate the copied pins so the URL is unreachable; the cached verified ZIP must still be used.
    const pf = path.join(d, 'scripts', 'agentel-runtime-pins.json');
    const p = JSON.parse(fs.readFileSync(pf, 'utf8')); p.runtimes.forEach((x) => { x.url = 'https://127.0.0.1:9/does-not-exist.zip'; }); fs.writeFileSync(pf, JSON.stringify(p));
    const r = runProvision(d);
    check('[2] cached run works with NO network (unreachable url)', r.code === 0 && /using cached verified ZIP/.test(r.out) && /PROVISIONED/.test(r.out), `exit ${r.code}`);
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ── 3. Corrupted cached ZIP is rejected (and, with an unreachable url, cannot silently proceed).
  { const d = freshCheckout(); seedCache(d, { corrupt: true });
    const pf = path.join(d, 'scripts', 'agentel-runtime-pins.json');
    const p = JSON.parse(fs.readFileSync(pf, 'utf8')); p.runtimes.forEach((x) => { x.url = 'https://127.0.0.1:9/x.zip'; }); fs.writeFileSync(pf, JSON.stringify(p));
    const r = runProvision(d);
    check('[3] corrupted cached ZIP is rejected (discarded, not extracted)', r.code !== 0 && /failed SHA-256|discarding/.test(r.out));
    check('[3] runtime NOT created from a corrupted ZIP', !fs.existsSync(runtimeNode(d)));
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ── 4. Wrong SHA pin is rejected (good ZIP, but pin mutated so bytes cannot match).
  { const d = freshCheckout(); seedCache(d);
    const pf = path.join(d, 'scripts', 'agentel-runtime-pins.json');
    const p = JSON.parse(fs.readFileSync(pf, 'utf8')); p.runtimes.forEach((x) => { x.sha256 = '0'.repeat(64); x.url = 'https://127.0.0.1:9/x.zip'; }); fs.writeFileSync(pf, JSON.stringify(p));
    const r = runProvision(d);
    check('[4] wrong SHA pin is rejected (never extracts an unverified archive)', r.code !== 0 && /SHA-256|failed SHA/.test(r.out));
    check('[4] runtime NOT created under a wrong pin', !fs.existsSync(runtimeNode(d)));
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ── 5. Partial extraction / crashed prior attempt is recovered (stale .agentel/node replaced).
  { const d = freshCheckout(); seedCache(d);
    // Simulate a crash mid-extract: a half-written runtime dir with only a stray file.
    const rd = path.join(d, '.agentel', 'node'); fs.mkdirSync(rd, { recursive: true }); fs.writeFileSync(path.join(rd, 'HALF_WRITTEN'), 'x');
    const r = runProvision(d);
    check('[5] partial/stale runtime is recovered (re-provisioned complete)', r.code === 0 && /PROVISIONED/.test(r.out));
    check('[5] stale half-written marker is gone after recovery', !fs.existsSync(path.join(rd, 'HALF_WRITTEN')) && fs.existsSync(runtimeNode(d)));
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ── 6. Incomplete runtime fails before acceptance (npm.cmd removed from a vendored dist).
  { const d = freshCheckout(); seedCache(d);
    // First provision a real complete runtime, then break it, then re-run: it must (re)provision or fail — never accept incomplete.
    let r = runProvision(d); check('[6] initial provision ok', r.code === 0);
    fs.rmSync(path.join(d, '.agentel', 'node', 'npm.cmd'), { force: true });
    // Make the cache ZIP unusable AND url unreachable so it CANNOT silently re-provision → must fail closed on incomplete.
    fs.rmSync(path.join(d, '.agentel', 'cache', pin.archive), { force: true });
    const pf = path.join(d, 'scripts', 'agentel-runtime-pins.json');
    const p = JSON.parse(fs.readFileSync(pf, 'utf8')); p.runtimes.forEach((x) => { x.url = 'https://127.0.0.1:9/x.zip'; }); fs.writeFileSync(pf, JSON.stringify(p));
    r = runProvision(d);
    check('[6] incomplete runtime is NOT accepted (fails closed)', r.code !== 0 && /incomplete|not complete|download|network/i.test(r.out));
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ── 7. AGENTEL_VERIFY_NODE overrides bootstrap (uses the override; no download/extract).
  { const d = freshCheckout(); // NO cache seeded — override must win before any provisioning.
    // Provision a runtime in a SEPARATE dir to use as the override.
    const od = freshCheckout(); seedCache(od); const orv = runProvision(od);
    check('[7] set up an override runtime', orv.code === 0);
    const overrideNode = runtimeNode(od);
    const r = runProvision(d, { AGENTEL_VERIFY_NODE: overrideNode });
    check('[7] AGENTEL_VERIFY_NODE overrides bootstrap (no provisioning in target)', r.code === 0 && /using AGENTEL_VERIFY_NODE/.test(r.out) && !fs.existsSync(path.join(d, '.agentel', 'node')));
    fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(od, { recursive: true, force: true });
  }

  log('');
  if (failed === 0) { log(`RESULT: AGENTEL_BOOTSTRAP_ACCEPT_PASS (${pass} checks)`); process.exit(0); }
  log(`RESULT: FAILED (${failed} of ${pass + failed} checks failed)`); process.exit(1);
} catch (e) {
  process.stderr.write('ACCEPT ERROR: ' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exit(1);
}
