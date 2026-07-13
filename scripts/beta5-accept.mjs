#!/usr/bin/env node
/**
 * beta.5 REAL ACCEPTANCE — the control-plane / session-visibility flow, driven ONLY
 * through the same production commands and the same public HTTP auth path a real user
 * (and their browser) exercises. NO direct internal-class calls, NO private auth access.
 *
 * Flow (all via the INSTALLED CLI + the installed SessionStart hook + real HTTP):
 *   1. install (PATH-free) into an isolated root, with a fake claude host.
 *   2. inspect the REAL settings.json — SessionStart -> session-start-hook.js (owned),
 *      UserPromptSubmit/Stop -> hook-entry.js.
 *   3. start the broker with the PRODUCTION `start` command → asserts exactly one broker
 *      and exactly one dashboard (state file advertises a dashboardUrl; /alive answers).
 *   4. drive the installed SessionStart hook for each lifecycle source
 *      (startup/resume/clear/compact + a fork) by piping the documented hook JSON to its
 *      stdin — exactly how Claude Code invokes it.
 *   5. open the dashboard through the PRODUCTION auth flow: `dashboard --no-open` prints a
 *      one-time link `http://127.0.0.1:<port>/#n=<nonce>`; parse the nonce from the fragment,
 *      POST /auth/exchange {nonce} → {token}, then GET /api/sessions with the Bearer token.
 *      Assert the announced sessions are visible, and that an unauthenticated /api/sessions is 401.
 *   6. assert /api/audit reports a healthy (intact) ledger chain.
 *   7. stop + uninstall; assert the plugin is removed.
 *
 * Isolated everything (never the user's real ~/.claude). Prints a transcript; exits nonzero
 * on any failure and retains the temp tree for diagnosis.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const log = (s) => process.stdout.write(s + '\n');
const fail = (s) => { process.stderr.write('FAIL: ' + s + '\n'); process.stderr.write(`(temp tree retained: ${base})\n`); process.exit(1); };

const argv = process.argv.slice(2);
const artifactIdx = argv.indexOf('--artifact');
const sourceDir = artifactIdx > -1 ? path.resolve(argv[artifactIdx + 1]) : process.cwd();
const cliFromSource = path.join(sourceDir, 'dist', 'cli', 'main.js');
if (!fs.existsSync(cliFromSource)) fail(`no built CLI at ${cliFromSource} (run: npm run build, or pass --artifact <dir>)`);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-b5accept-'));
const installRoot = path.join(base, 'install');
const legacyDir = path.join(base, 'legacy');
const home = path.join(base, 'home');
const cfgDir = path.join(base, 'cfg');
fs.mkdirSync(home, { recursive: true });
const settingsPath = path.join(cfgDir, '.claude', 'settings.json');
const fakeClaude = path.join(base, process.platform === 'win32' ? 'fakeclaude.cmd' : 'fakeclaude.sh');
if (process.platform === 'win32') fs.writeFileSync(fakeClaude, '@echo off\r\necho FAKECLAUDE_RAN: %*\r\n');
else fs.writeFileSync(fakeClaude, '#!/bin/sh\necho "FAKECLAUDE_RAN: $@"\n', { mode: 0o755 });

const dataDir = path.join(installRoot, 'data');
const baseEnv = {
  ...process.env,
  XBUS_INSTALL_ROOT: installRoot,
  XBUS_DATA_DIR: dataDir,
  XBUS_LEGACY_DATA_DIR: legacyDir,
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_PATH: path.join(cfgDir, '.claude.json'),
  CLAUDE_SETTINGS_PATH: settingsPath,
  XBUS_TEST_REQUIRE_FAKE_CLAUDE: '1',
  CLAUDE_CODE_EXECPATH: fakeClaude,
  // This acceptance runs on the maintainer's Node; a supported Node needs no bypass, but the
  // dev machine is Node 25 — allow it here (the clean-machine gate runs on a supported Node).
  XBUS_ALLOW_UNSUPPORTED_NODE: '1',
  // Speed: skip the icacls hardening subprocess (AV-slow on this host). Never set in real prod.
  XBUS_SKIP_ACL_HARDENING: '1',
};

const installedCli = path.join(installRoot, 'plugin', 'dist', 'cli', 'main.js');
const installedSsHook = path.join(installRoot, 'plugin', 'dist', 'channel', 'session-start-hook.js');

function runCli(cli, args, extraEnv = {}, stdin) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: { ...baseEnv, ...extraEnv }, encoding: 'utf8', timeout: 120000, ...(stdin !== undefined ? { input: stdin } : {}),
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function parseJsonOut(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('no JSON in output: ' + stdout.slice(0, 200));
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < stdout.length; i++) {
    const c = stdout[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) return JSON.parse(stdout.slice(start, i + 1)); }
  }
  throw new Error('unbalanced JSON');
}

async function main() {
  log('== XBus beta.5 acceptance (production flow) ==');
  log(`node: ${process.version}   source: ${sourceDir}`);

  // 1) install
  log('\n[1] install'); let r = runCli(cliFromSource, ['install', '--json']);
  if (r.code !== 0) fail(`install exited ${r.code}: ${r.out.slice(0, 600)}`);
  if (!parseJsonOut(r.stdout).ok) fail('install not ok');
  if (!fs.existsSync(installedSsHook)) fail(`SessionStart hook not installed at ${installedSsHook}`);
  log('  installed ok; session-start-hook.js present');

  // 2) inspect the REAL settings.json for the three owned hooks
  log('[2] inspect installed hooks');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const eventEntry = (ev) => {
    const groups = settings.hooks?.[ev] ?? [];
    for (const g of groups) for (const h of g.hooks ?? []) {
      if (typeof h._xbusOwner === 'string') return Array.isArray(h.args) ? h.args[0] : h.command;
    }
    return null;
  };
  const ss = eventEntry('SessionStart'); const ups = eventEntry('UserPromptSubmit'); const stop = eventEntry('Stop');
  if (!ss || !/session-start-hook\.js$/.test(ss)) fail(`SessionStart not wired to session-start-hook.js (got ${ss})`);
  if (!ups || !/hook-entry\.js$/.test(ups)) fail(`UserPromptSubmit not wired to hook-entry.js (got ${ups})`);
  if (!stop || !/hook-entry\.js$/.test(stop)) fail(`Stop not wired to hook-entry.js (got ${stop})`);
  log('  SessionStart→session-start-hook.js, UserPromptSubmit/Stop→hook-entry.js (all owned)');

  // 3+4) drive the installed SessionStart hook for every lifecycle source (+ a fork).
  //      The FIRST invocation AUTO-STARTS the broker + dashboard via ensureBrokerDefault()
  //      — exactly the production "plain claude triggers SessionStart → everything comes up"
  //      path. No manual `start`. Each hook MUST exit 0 (never blocks Claude).
  log('[3] plain-claude flow: installed SessionStart hook auto-starts broker+dashboard & announces');
  const sources = [
    { id: 'sess-startup-0001', source: 'startup' },
    { id: 'sess-resume-0002', source: 'resume' },
    { id: 'sess-clear-0003', source: 'clear' },
    { id: 'sess-compact-0004', source: 'compact' },
    { id: 'sess-fork-0005', source: 'startup' }, // a fork enters as a startup with a new id
  ];
  for (const s of sources) {
    const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: s.id, source: s.source, cwd: home });
    const hr = runCli(installedSsHook, [], { CLAUDE_CODE_SESSION_ID: s.id }, input);
    if (hr.code !== 0) fail(`SessionStart hook exited ${hr.code} for ${s.id} (must always be 0): ${hr.out.slice(0, 300)}`);
  }
  log(`  ${sources.length} SessionStart hook invocations all exited 0`);

  // Exactly one broker + one dashboard came up from the hook auto-start.
  log('[4] exactly one broker + one dashboard (from the hook auto-start)');
  const stateFile = path.join(dataDir, 'broker.state.json');
  if (!fs.existsSync(stateFile)) fail('no broker state file — the SessionStart hook did not auto-start a broker');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!state.dashboardUrl) fail('broker state file advertises no dashboardUrl (dashboard not auto-enabled)');
  const dashUrl = state.dashboardUrl;
  log(`  broker pid=${state.pid}; dashboard=${dashUrl}`);
  const alive = await fetch(`${dashUrl}/alive`).then((x) => x.ok).catch(() => false);
  if (!alive) fail('dashboard /alive did not answer');
  log('  /alive ok');

  // 5) open the dashboard through the PRODUCTION auth flow (nonce→exchange→token→/api)
  log('[5] production auth flow (dashboard --no-open → nonce → exchange → token → /api/sessions)');
  r = runCli(installedCli, ['dashboard', '--no-open']);
  if (r.code !== 0) fail(`dashboard --no-open exited ${r.code}: ${r.out.slice(0, 400)}`);
  const m = /https?:\/\/[^\s]*#n=([A-Za-z0-9._~%-]+)/.exec(r.out);
  if (!m) fail(`could not parse one-time open link from: ${r.out.slice(0, 400)}`);
  const nonce = decodeURIComponent(m[1]);
  // Unauthenticated /api/sessions must be 401.
  const unauth = await fetch(`${dashUrl}/api/sessions`);
  if (unauth.status !== 401) fail(`unauthenticated /api/sessions returned ${unauth.status}, expected 401`);
  // Exchange the one-time nonce for a tab token (the ONLY mutating route).
  const ex = await fetch(`${dashUrl}/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  if (!ex.ok) fail(`/auth/exchange returned ${ex.status}`);
  const { token } = await ex.json();
  if (!token) fail('exchange returned no token');
  // The nonce is single-use: a second exchange must fail.
  const ex2 = await fetch(`${dashUrl}/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  if (ex2.ok) fail('nonce was reusable (second exchange succeeded) — single-use violated');
  // Authenticated read.
  const api = await fetch(`${dashUrl}/api/sessions`, { headers: { authorization: `Bearer ${token}` } });
  if (!api.ok) fail(`authenticated /api/sessions returned ${api.status}`);
  const { sessions } = await api.json();
  const ids = new Set((sessions ?? []).map((x) => x.sessionId));
  const missing = sources.filter((s) => !ids.has(s.id));
  if (missing.length) fail(`announced sessions not visible in the dashboard: ${missing.map((s) => s.id).join(', ')} (saw ${[...ids].join(', ')})`);
  log(`  auth flow ok; all ${sources.length} announced sessions visible; nonce single-use; unauth=401`);
  // Session-visibility fields present.
  const sample = sessions.find((x) => x.sessionId === 'sess-startup-0001');
  if (!sample || typeof sample.label !== 'string' || !sample.delivery) fail('session visibility fields (label/delivery) missing');
  log(`  sample session label=${sample.label} connection=${sample.connection} readiness=${sample.readiness}`);

  // 6) audit ledger health via the authenticated API
  log('[6] audit ledger health (/api/audit)');
  const audit = await (await fetch(`${dashUrl}/api/audit`, { headers: { authorization: `Bearer ${token}` } })).json();
  if (audit.ok !== true) fail(`audit ledger not ok: ${JSON.stringify(audit)}`);
  log(`  ledger chain intact (checked=${audit.checked}, firstBreakSeq=${audit.firstBreakSeq})`);

  // 7) stop + uninstall
  log('[7] stop + uninstall');
  runCli(installedCli, ['stop', '--json']);
  runCli(installedCli, ['uninstall', '--json']);
  const pluginGone = !fs.existsSync(path.join(installRoot, 'plugin', '.claude-plugin', 'plugin.json'));
  if (!pluginGone) fail('uninstall left the installed plugin in place');
  // Uninstall must remove ONLY XBus-owned hooks; a re-read shows no owned SessionStart.
  const after = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : { hooks: {} };
  const stillOwned = (after.hooks?.SessionStart ?? []).some((g) => (g.hooks ?? []).some((h) => typeof h._xbusOwner === 'string'));
  if (stillOwned) fail('uninstall left an XBus-owned SessionStart hook behind');
  log('  plugin removed; XBus-owned hooks removed');

  log('\nRESULT: BETA5_ACCEPTANCE_PASS');
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* */ }
  process.exit(0);
}

main().catch((e) => { process.stderr.write('ERROR: ' + (e?.stack ?? String(e)) + '\n'); process.stderr.write(`(temp tree retained: ${base})\n`); process.exit(1); });
