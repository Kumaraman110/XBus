/**
 * install() / uninstall() ↔ user-scope Claude config integration (beta.4, ADR 0012
 * Decision 8). Proves the full install flow registers XBus into a (temp) Claude
 * config and uninstall reverses it, preserving the user's unrelated entries — and
 * that a user-scope registration failure rolls back the WHOLE install.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { install, uninstall } from '../../src/cli/install.js';
import { readClaudeConfig, readClaudeSettings, XBUS_OWNER_TAG } from '../../src/cli/user-scope-config.js';

const REPO = path.resolve(__dirname, '../..');
let root: string; let cfgDir: string; let configPath: string; let settingsPath: string; let dataDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-ius-root-'));
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-ius-cfg-'));
  configPath = path.join(cfgDir, '.claude.json');
  settingsPath = path.join(cfgDir, '.claude', 'settings.json');
  dataDir = path.join(root, 'data');
});
afterEach(() => {
  for (const d of [root, cfgDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});
function hasOurHooks(): boolean {
  const s = readClaudeSettings(settingsPath);
  return !!s?.hooks && ['UserPromptSubmit', 'Stop'].every((ev) => (s.hooks![ev] ?? []).some((g) => g.hooks.some((h) => JSON.stringify(h).includes('hook-entry.js'))));
}
function inst(over: Record<string, unknown> = {}): Promise<Awaited<ReturnType<typeof install>>> {
  return install({ source: REPO, installRoot: root, dataDir, claudeConfigPath: configPath, claudeSettingsPath: settingsPath, nodePath: process.execPath, ...over });
}

describe('install registers user-scope Claude config', () => {
  it('writes the mcp server to .claude.json and the HOOKS to settings.json; records both in the manifest', async () => {
    const r = await inst();
    expect(r.ok, r.error).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    expect(cfg.mcpServers?.xbus).toBeDefined();
    expect(cfg.mcpServers!.xbus[XBUS_OWNER_TAG]).toBeTruthy();
    expect((cfg.mcpServers!.xbus.args as string[]).some((a) => a.includes('server.js'))).toBe(true);
    // Hooks are NOT in the config file (would be ignored there) — they are in settings.
    expect((cfg as Record<string, unknown>).hooks).toBeUndefined();
    expect(hasOurHooks()).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'install-manifest.json'), 'utf8'));
    expect(manifest.installId).toBeTruthy();
    expect(manifest.userScope.configPath).toBe(configPath);
    expect(manifest.userScope.settingsPath).toBe(settingsPath);
  });

  it('preserves the user’s pre-existing mcp servers + top-level keys', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { mine: { command: 'c', args: [] } }, theme: 'dark' }, null, 2));
    const r = await inst();
    expect(r.ok, r.error).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    expect(cfg.mcpServers!.mine).toEqual({ command: 'c', args: [] });
    expect((cfg as Record<string, unknown>).theme).toBe('dark');
    expect(cfg.mcpServers!.xbus).toBeDefined();
  });

  it('uninstall removes ONLY the XBus entries from BOTH files', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { mine: { command: 'c', args: [] } } }, null, 2));
    await inst();
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus).toBeDefined();
    expect(hasOurHooks()).toBe(true);
    const u = uninstall({ installRoot: root });
    expect(u.ok).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    expect(cfg.mcpServers!.xbus).toBeUndefined(); // ours gone
    expect(cfg.mcpServers!.mine).toEqual({ command: 'c', args: [] }); // theirs kept
    expect(hasOurHooks()).toBe(false); // our hooks gone
  });

  it('registerUserScope:false performs a plugin-only install (neither file touched)', async () => {
    const r = await inst({ registerUserScope: false });
    expect(r.ok, r.error).toBe(true);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(settingsPath)).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'install-manifest.json'), 'utf8'));
    expect(manifest.userScope).toBeUndefined();
  });

  it('a user-scope conflict (unowned xbus key) rolls back the WHOLE install', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { xbus: { command: 'someoneElse', args: [] } } }, null, 2));
    const r = await inst();
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(fs.existsSync(path.join(root, 'install-manifest.json'))).toBe(false);
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus.command).toBe('someoneElse');
  });
});
