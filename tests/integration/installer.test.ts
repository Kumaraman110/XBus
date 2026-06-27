/**
 * F-B — xbus install / uninstall against an ISOLATED install root + data
 * dir (never the real ~/.claude). Exercises the install module directly AND the
 * compiled CLI entry (dist/cli/main.js) so the actual shipped command is tested.
 *
 * Requires `dist/` (suite pretest builds it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { install, uninstall, planInstall } from '../../src/cli/install.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'dist', 'cli', 'main.js');
let root: string;

let prevLegacy: string | undefined;
beforeEach(() => {
  if (!fs.existsSync(CLI)) throw new Error('dist/ missing — run `npm run build`');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-inst-'));
  // Hermetic: pin the legacy data root to an isolated, empty dir so the install's
  // migration decision never depends on the real ~/.claude/xbus on this machine
  // (the comment above promises "never the real ~/.claude"). Without this, a
  // populated real legacy root turns these install paths into a migration and
  // breaks the post-swap-failure assertions.
  prevLegacy = process.env.XBUS_LEGACY_DATA_DIR;
  process.env.XBUS_LEGACY_DATA_DIR = path.join(root, 'isolated-legacy-root');
});
afterEach(() => {
  if (prevLegacy === undefined) delete process.env.XBUS_LEGACY_DATA_DIR; else process.env.XBUS_LEGACY_DATA_DIR = prevLegacy;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runCli(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

describe('F-B — installer', () => {
  it('dry-run reports the plan and writes NOTHING', async () => {
    const r = await install({ installRoot: root, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.plan.filesToWrite).toBeGreaterThan(0);
    // Nothing created.
    expect(fs.existsSync(path.join(root, 'plugin'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'install-manifest.json'))).toBe(false);
  });

  it('install copies the plugin, generates the secret, passes health, writes a manifest', async () => {
    const r = await install({ installRoot: root });
    expect(r.ok, r.error).toBe(true);
    expect(r.health?.ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'plugin', 'dist', 'channel', 'server.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'plugin', 'dist', 'launcher', 'xclaude.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'data', 'auth', 'root.secret'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'install-manifest.json'), 'utf8'));
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(manifest.pluginDir).toContain('plugin');
  });

  it('install is idempotent: a second install backs up the prior plugin and still succeeds', async () => {
    await install({ installRoot: root });
    const r2 = await install({ installRoot: root });
    expect(r2.ok, r2.error).toBe(true);
    // a backup of the prior plugin dir was taken
    const backups = fs.readdirSync(root).filter((e) => e.startsWith('.plugin.backup-'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('install does NOT create files in the current working directory', async () => {
    const cwdBefore = fs.readdirSync(REPO).sort().join(',');
    await install({ installRoot: root });
    const cwdAfter = fs.readdirSync(REPO).sort().join(',');
    expect(cwdAfter).toBe(cwdBefore); // REPO untouched (install went to `root`)
  });

  it('uninstall (retain data) removes plugin + manifest but keeps the secret; idempotent', async () => {
    await install({ installRoot: root });
    const u = uninstall({ installRoot: root });
    expect(u.ok).toBe(true);
    expect(u.retainedData).toBe(true);
    expect(fs.existsSync(path.join(root, 'plugin'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'install-manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'data', 'auth', 'root.secret'))).toBe(true); // retained
    // idempotent
    const u2 = uninstall({ installRoot: root });
    expect(u2.notInstalled).toBe(true);
  });

  it('uninstall --remove-data removes the secret too', async () => {
    await install({ installRoot: root });
    const u = uninstall({ installRoot: root, removeData: true });
    expect(u.ok).toBe(true);
    expect(u.retainedData).toBe(false);
    expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
  });

  it('uninstall preserves UNRELATED files under the install root', async () => {
    await install({ installRoot: root });
    const unrelated = path.join(root, 'unrelated-user-file.txt');
    fs.writeFileSync(unrelated, 'keep me');
    uninstall({ installRoot: root });
    expect(fs.existsSync(unrelated)).toBe(true); // not ours → not removed
  });

  it('the compiled CLI entry runs install --dry-run + --json (the shipped command works)', () => {
    const r = runCli(['install', '--dry-run', '--json'], { XBUS_INSTALL_ROOT: root });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.dryRun).toBe(true);
    expect(j.plan.filesToWrite).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, 'plugin'))).toBe(false);
  });

  it('the compiled CLI install→uninstall round-trips on disk', () => {
    const inst = runCli(['install'], { XBUS_INSTALL_ROOT: root });
    expect(inst.code, inst.out).toBe(0);
    expect(fs.existsSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
    const un = runCli(['uninstall', '--remove-data'], { XBUS_INSTALL_ROOT: root });
    expect(un.code, un.out).toBe(0);
    expect(fs.existsSync(path.join(root, 'plugin'))).toBe(false);
  });

  it('a failed install (post-swap error) FULLY rolls back: no plugin, no manifest', async () => {
    // Force a post-swap failure: point dataDir at an existing FILE so mkdir fails
    // AFTER the plugin has been staged + swapped.
    const badData = path.join(root, 'data-as-file');
    fs.writeFileSync(badData, 'file not dir');
    const r = await install({ installRoot: root, dataDir: badData });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(fs.existsSync(path.join(root, 'plugin'))).toBe(false); // swapped plugin removed
    expect(fs.existsSync(path.join(root, 'install-manifest.json'))).toBe(false);
  });

  it('a failed RE-install restores the prior plugin (backup rollback)', async () => {
    await install({ installRoot: root }); // good install
    const sentinel = path.join(root, 'plugin', 'SENTINEL.txt');
    fs.writeFileSync(sentinel, 'original install');
    // Second install that fails post-swap must restore the prior plugin (sentinel back).
    const badData = path.join(root, 'data-as-file2');
    fs.writeFileSync(badData, 'file not dir');
    const r = await install({ installRoot: root, dataDir: badData });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(fs.existsSync(sentinel), 'prior plugin restored from backup').toBe(true);
  });

  it('planInstall rejects a source that is not a built plugin', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-notbuilt-'));
    try {
      expect(() => planInstall({ source: empty, installRoot: root })).toThrow(/not a built XBus plugin|missing/);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });
});
