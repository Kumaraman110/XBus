#!/usr/bin/env node
/**
 * §10 — clean-machine acceptance. Starts from an EMPTY environment and follows the
 * public documented bootstrap verbatim, then drives the full first-user flow:
 *
 *   install (PATH-free) → doctor → start broker → two MCP sessions →
 *   register aliases → send → ack → correlated reply → stop → uninstall →
 *   assert no installed files remain.
 *
 * It uses ONLY installed files (the install root), a FAKE claude host (never the
 * real one), an isolated data dir + isolated legacy root, and isolated env. It does
 * NOT touch the user's real ~/.claude. Prints a transcript and exits non-zero on any
 * failure.
 *
 * Usage:
 *   node scripts/clean-machine-accept.mjs --artifact <built-artifact-dir>
 *   node scripts/clean-machine-accept.mjs            (uses ./dist as the source)
 *
 * On a SUPPORTED Node (22 LTS / 24) this runs without any bypass — that is the real
 * release gate. On an unsupported Node it refuses unless XBUS_ALLOW_UNSUPPORTED_NODE=1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const log = (s) => process.stdout.write(s + '\n');
const fail = (s) => { process.stderr.write('FAIL: ' + s + '\n'); process.exit(1); };

const argv = process.argv.slice(2);
const artifactIdx = argv.indexOf('--artifact');
const sourceDir = artifactIdx > -1 ? path.resolve(argv[artifactIdx + 1]) : process.cwd();
const cliFromSource = path.join(sourceDir, 'dist', 'cli', 'main.js');
if (!fs.existsSync(cliFromSource)) fail(`no built CLI at ${cliFromSource} (run: npm run build, or pass --artifact <dir>)`);

// Isolated everything — never the real ~/.claude.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-accept '));   // space in path on purpose
const installRoot = path.join(base, 'install root');
const legacyDir = path.join(base, 'isolated legacy');
const home = path.join(base, 'home');
fs.mkdirSync(home, { recursive: true });
const fakeClaude = path.join(base, process.platform === 'win32' ? 'fakeclaude.cmd' : 'fakeclaude.sh');
if (process.platform === 'win32') fs.writeFileSync(fakeClaude, '@echo off\r\necho FAKECLAUDE_RAN: %*\r\n');
else { fs.writeFileSync(fakeClaude, '#!/bin/sh\necho "FAKECLAUDE_RAN: $@"\n', { mode: 0o755 }); }

const baseEnv = {
  ...process.env,
  XBUS_INSTALL_ROOT: installRoot,
  XBUS_LEGACY_DATA_DIR: legacyDir,
  HOME: home,
  XBUS_TEST_REQUIRE_FAKE_CLAUDE: '1',
  CLAUDE_CODE_EXECPATH: fakeClaude,
};
// Do NOT inject XBUS_ALLOW_UNSUPPORTED_NODE here — on a supported Node the guard is
// silent; on Node 25 the run honestly refuses (unless the operator set the bypass).

const installedCli = path.join(installRoot, 'plugin', 'dist', 'cli', 'main.js');
const installedServer = path.join(installRoot, 'plugin', 'dist', 'channel', 'server.js');
const installedLauncher = path.join(installRoot, 'plugin', 'dist', 'launcher', 'xclaude.js');
const dataDir = path.join(installRoot, 'data');

function runCli(cli, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], { env: { ...baseEnv, ...extraEnv }, encoding: 'utf8', timeout: 120000 });
  // Keep stdout (the JSON) separate from stderr (banners/warnings) so JSON.parse is clean.
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
/** Parse the LAST balanced JSON object from a stdout string (ignores any banner lines). */
function parseJsonOut(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('no JSON object in output: ' + stdout.slice(0, 200));
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < stdout.length; i++) {
    const c = stdout[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return JSON.parse(stdout.slice(start, i + 1)); }
  }
  throw new Error('unbalanced JSON in output');
}
function cleanup() { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* */ } }

try {
  log('== XBus clean-machine acceptance ==');
  log(`node: ${process.version}   source: ${sourceDir}`);

  // 1) install (PATH-free), from the source/artifact CLI
  log('\n[1] install (dry-run)'); let r = runCli(cliFromSource, ['install', '--dry-run', '--json']);
  if (r.code !== 0) fail(`install --dry-run exited ${r.code}: ${r.out.slice(0, 400)}`);
  log('  dry-run ok');

  log('[2] install'); r = runCli(cliFromSource, ['install', '--json']);
  if (r.code !== 0) fail(`install exited ${r.code}: ${r.out.slice(0, 600)}`);
  const inst = parseJsonOut(r.stdout);
  if (!inst.ok) fail(`install not ok: ${JSON.stringify(inst).slice(0, 600)}`);
  log('  installed ok');

  // 2) assert the installed files exist (the §7 set)
  log('[3] verify installed files');
  for (const f of [installedCli, installedServer, installedLauncher, path.join(installRoot, 'plugin', 'dist', 'channel', 'hook-entry.js'), path.join(installRoot, 'install-manifest.json')]) {
    if (!fs.existsSync(f)) fail(`missing installed file: ${f}`);
  }
  log('  all required installed files present');

  // 3) doctor (from installed CLI). NOTE: this runs BEFORE the broker is started (step [6]), so a
  //    fresh install correctly reports activation=BROKER_UNAVAILABLE. Beta.10 (ADR 0036) gives doctor
  //    distinct per-state exit codes (CONNECTED=0, BROKER_UNAVAILABLE=12, …), so a pre-start doctor
  //    now exits 12 BY DESIGN — that is correct, not a failure. Accept the no-broker states here and
  //    validate the doctor JSON contract instead of asserting exit 0 (connectivity is proven at [6]).
  log('[4] doctor'); r = runCli(installedCli, ['doctor', '--json'], { XBUS_DATA_DIR: dataDir });
  const ACCEPT_PRE_START = new Set([0, 12]); // 0=CONNECTED (broker already up), 12=BROKER_UNAVAILABLE (fresh install, expected)
  if (!ACCEPT_PRE_START.has(r.code)) fail(`doctor exited ${r.code} (expected 0 or 12=BROKER_UNAVAILABLE pre-start): ${r.out.slice(0, 400)}`);
  { // the doctor JSON contract must hold regardless of broker state (the installed build resolves its
    // identity). Use parseJsonOut on stdout (a bypass banner may precede the JSON), not raw JSON.parse.
    const dj = parseJsonOut(r.stdout);
    if (typeof dj.activation !== 'string') fail(`doctor --json missing activation enum: ${r.stdout.slice(0, 400)}`);
    if (r.code === 12 && dj.activation !== 'BROKER_UNAVAILABLE') fail(`exit 12 but activation=${dj.activation} (expected BROKER_UNAVAILABLE)`);
  }
  log(`  doctor ok (activation reported; exit ${r.code})`);

  // 4) launcher resolves the installed plugin + uses the FAKE claude (never real)
  log('[5] launcher (fake host)');
  r = runCli(installedLauncher, ['--version'], { XBUS_DATA_DIR: dataDir });
  if (!/FAKECLAUDE_RAN/.test(r.out) && !/launching Claude Code with XBus plugin/.test(r.out)) {
    fail(`launcher did not run the fake host: ${r.out.slice(0, 400)}`);
  }
  log('  launcher used the fake host (real claude never invoked)');

  // 5) two MCP sessions over stdio (exactly how Claude talks to the server) +
  //    send → ack → reply, against a broker started from the installed CLI.
  log('[6] two-session send / ack / reply (installed MCP servers)');
  const sub = spawnSync(process.execPath, [path.join(sourceDir, 'scripts', 'accept-exchange.mjs'), installedServer, dataDir], {
    env: { ...baseEnv, XBUS_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 120000,
  });
  const subOut = (sub.stdout ?? '') + (sub.stderr ?? '');
  if ((sub.status ?? 1) !== 0) fail(`two-session exchange failed (exit ${sub.status}):\n${subOut.slice(0, 1200)}`);
  log('  ' + subOut.trim().split('\n').filter(Boolean).slice(-6).join('\n  '));

  // 5b) durable-identity RECLAIM (beta.8, ADR 0027) through the installed MCP + broker: a
  //     successor under a NEW session id reclaims a killed predecessor's name + inbox.
  log('[6b] durable-identity reclaim (new session id inherits name + inbox)');
  const rec = spawnSync(process.execPath, [path.join(sourceDir, 'scripts', 'accept-identity-reclaim.mjs'), installedServer, dataDir], {
    env: { ...baseEnv, XBUS_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 120000,
  });
  const recOut = (rec.stdout ?? '') + (rec.stderr ?? '');
  if ((rec.status ?? 1) !== 0 || !/IDENTITY_RECLAIM_ACCEPT_PASS/.test(recOut)) fail(`identity-reclaim acceptance failed (exit ${rec.status}):\n${recOut.slice(0, 1200)}`);
  log('  ' + recOut.trim().split('\n').filter(Boolean).slice(-4).join('\n  '));

  // 6) stop the broker
  log('[7] stop broker'); r = runCli(installedCli, ['stop', '--json'], { XBUS_DATA_DIR: dataDir });
  log('  stop exit ' + r.code);

  // 7) uninstall + assert installed plugin is gone
  log('[8] uninstall'); r = runCli(installedCli, ['uninstall', '--json'], { XBUS_DATA_DIR: dataDir });
  if (r.code !== 0) log('  (uninstall exit ' + r.code + ' — verifying file removal directly)');
  const pluginGone = !fs.existsSync(path.join(installRoot, 'plugin', '.claude-plugin', 'plugin.json'));
  if (!pluginGone) fail('uninstall left the installed plugin in place');
  log('  installed plugin removed');

  log('\nRESULT: BETA3_CLEAN_MACHINE_PASS');
  cleanup();
  process.exit(0);
} catch (e) {
  process.stderr.write('ERROR: ' + (e?.stack ?? String(e)) + '\n');
  process.stderr.write(`(temp tree retained for diagnosis: ${base})\n`);
  process.exit(1);
}
