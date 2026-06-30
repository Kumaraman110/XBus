#!/usr/bin/env node
/**
 * Beta.4 zero-friction acceptance (ADR 0012). Extends the beta.3 clean-machine flow
 * with the beta.4 promises that CAN be machine-verified end-to-end WITHOUT a live
 * model:
 *
 *   install (user-scope) → assert XBus is registered in the user's Claude config
 *     (mcpServers in .claude.json + hooks in .claude/settings.json, ownership-tagged)
 *   → ensureBroker auto-start (no manual `xbus start`)
 *   → two real MCP server processes auto-register with auto-derived NAMES
 *   → discover each other BY NAME; exchange request/ack/reply + fire-and-forget
 *   → duplicate-name collision → second goes pending → resolves via xbus_rename
 *   → concurrency: many concurrent ensureBroker callers → exactly ONE broker
 *   → 15-day expiry via an injected clock (broker-side, deterministic)
 *   → uninstall → assert BOTH config files are restored (only XBus entries removed)
 *
 * It uses ONLY installed files, a FAKE claude host, an isolated HOME + data dir +
 * isolated CLAUDE_CONFIG_PATH/CLAUDE_SETTINGS_PATH, and never touches the real
 * ~/.claude. The IRREDUCIBLE interactive step — driving the REAL `claude` CLI with a
 * model so a human sees XBus load + messages inject at a live checkpoint — is NOT
 * performed here (no model); it is documented in docs/beta4-acceptance-runbook.md and
 * must be executed by a human. This script proves everything up to that boundary.
 *
 * Usage: node scripts/beta4-accept.mjs [--artifact <built-artifact-dir>]
 * Exits non-zero on any failure; prints a transcript.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const log = (s) => process.stdout.write(s + '\n');
const fail = (s) => { process.stderr.write('FAIL: ' + s + '\n'); process.stderr.write(`(temp tree retained: ${base})\n`); process.exit(1); };

const argv = process.argv.slice(2);
const ai = argv.indexOf('--artifact');
const sourceDir = ai > -1 ? path.resolve(argv[ai + 1]) : process.cwd();
const cliFromSource = path.join(sourceDir, 'dist', 'cli', 'main.js');
if (!fs.existsSync(cliFromSource)) fail(`no built CLI at ${cliFromSource} (run: npm run build)`);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-b4accept '));
const installRoot = path.join(base, 'install root');
const home = path.join(base, 'home'); fs.mkdirSync(home, { recursive: true });
const claudeConfig = path.join(base, 'cfg', '.claude.json');
const claudeSettings = path.join(base, 'cfg', '.claude', 'settings.json');
const legacyDir = path.join(base, 'isolated legacy');
const fakeClaude = path.join(base, process.platform === 'win32' ? 'fakeclaude.cmd' : 'fakeclaude.sh');
if (process.platform === 'win32') fs.writeFileSync(fakeClaude, '@echo off\r\necho FAKECLAUDE_RAN: %*\r\n');
else { fs.writeFileSync(fakeClaude, '#!/bin/sh\necho "FAKECLAUDE_RAN: $@"\n', { mode: 0o755 }); }

const env = {
  ...process.env,
  XBUS_INSTALL_ROOT: installRoot, XBUS_LEGACY_DATA_DIR: legacyDir, HOME: home,
  CLAUDE_CONFIG_PATH: claudeConfig, CLAUDE_SETTINGS_PATH: claudeSettings,
  XBUS_TEST_REQUIRE_FAKE_CLAUDE: '1', CLAUDE_CODE_EXECPATH: fakeClaude,
};
const installedCli = path.join(installRoot, 'plugin', 'dist', 'cli', 'main.js');
const dataDir = path.join(installRoot, 'data');

function runCli(cli, args, extra = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 180000 });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' };
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok, detail }); log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fail(`${name}: ${detail}`); }

try {
  log('== XBus beta.4 zero-friction acceptance ==');
  log(`node: ${process.version}   source: ${sourceDir}\n`);

  log('[1] install with user-scope registration');
  let r = runCli(cliFromSource, ['install', '--json']);
  check('install ok', r.code === 0 && readJson(r.stdout.slice(r.stdout.indexOf('{'))).ok, r.code === 0 ? '' : r.out.slice(0, 400));

  log('[2] XBus registered in the user Claude config (two files, ownership-tagged)');
  const cfg = readJson(claudeConfig);
  check('mcp server in .claude.json', !!cfg.mcpServers?.xbus, 'mcpServers.xbus present');
  check('mcp NOT carrying hooks', cfg.hooks === undefined, 'hooks not co-located in .claude.json');
  const settings = readJson(claudeSettings);
  const hookOk = ['UserPromptSubmit', 'Stop'].every((ev) => (settings.hooks?.[ev] ?? []).some((g) => g.hooks.some((h) => JSON.stringify(h).includes('hook-entry.js'))));
  check('hooks in .claude/settings.json', hookOk, 'UserPromptSubmit + Stop reference hook-entry.js');
  const manifest = readJson(path.join(installRoot, 'install-manifest.json'));
  check('manifest records both config paths + installId', !!manifest.installId && manifest.userScope?.configPath === claudeConfig && manifest.userScope?.settingsPath === claudeSettings, manifest.installId);

  log('[3] doctor against the installed CLI');
  r = runCli(installedCli, ['doctor', '--json'], { XBUS_DATA_DIR: dataDir });
  check('doctor ok', r.code === 0, r.code === 0 ? '' : r.out.slice(0, 300));

  log('[4] broker auto-start + named two-session exchange + duplicate→rename + concurrency + expiry');
  // The heavy beta.4 broker-side proofs run in a dedicated harness so they share one
  // installed-server + data-dir context (mirrors accept-exchange.mjs for beta.3).
  const harness = path.join(sourceDir, 'scripts', 'beta4-accept-exchange.mjs');
  const sub = spawnSync(process.execPath, [harness, path.join(installRoot, 'plugin', 'dist', 'channel', 'server.js'), dataDir], {
    env: { ...env, XBUS_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 180000,
  });
  const subOut = (sub.stdout ?? '') + (sub.stderr ?? '');
  check('beta.4 exchange harness passed', (sub.status ?? 1) === 0, (sub.status ?? 1) === 0 ? subOut.trim().split('\n').slice(-1)[0] : subOut.slice(-1200));
  subOut.trim().split('\n').filter((l) => /\[(PASS|FAIL)\]/.test(l)).forEach((l) => log('    ' + l.trim()));

  log('[5] uninstall restores BOTH config files (only XBus entries removed)');
  r = runCli(installedCli, ['uninstall', '--json'], { XBUS_DATA_DIR: dataDir });
  const cfgAfter = readJson(claudeConfig);
  const setAfter = readJson(claudeSettings);
  check('xbus mcp entry removed', cfgAfter.mcpServers?.xbus === undefined, 'mcpServers.xbus gone');
  const ourHookGone = !JSON.stringify(setAfter.hooks ?? {}).includes('hook-entry.js');
  check('xbus hooks removed', ourHookGone, 'no hook-entry.js in settings');
  check('installed plugin removed', !fs.existsSync(path.join(installRoot, 'plugin', '.claude-plugin', 'plugin.json')), '');

  log('\nRESULT: BETA4_AUTOMATED_ACCEPTANCE_PASS');
  log('NOTE: the live plain-`claude` (real model) leg is human-gated — see docs/beta4-acceptance-runbook.md.');
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* */ }
  process.exit(0);
} catch (e) {
  process.stderr.write('ERROR: ' + (e?.stack ?? String(e)) + '\n');
  process.stderr.write(`(temp tree retained: ${base})\n`);
  process.exit(1);
}
