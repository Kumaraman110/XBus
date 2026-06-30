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
import { readClaudeConfig, XBUS_OWNER_TAG } from '../../src/cli/user-scope-config.js';

const REPO = path.resolve(__dirname, '../..');
let root: string; let configPath: string; let dataDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-ius-root-'));
  configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-ius-cfg-')), 'claude.json');
  dataDir = path.join(root, 'data');
});
afterEach(() => {
  for (const d of [root, path.dirname(configPath)]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('install registers user-scope Claude config', () => {
  it('install adds the XBus mcp server + hooks (ownership-tagged) and records it in the manifest', async () => {
    const r = await install({ source: REPO, installRoot: root, dataDir, claudeConfigPath: configPath, nodePath: process.execPath });
    expect(r.ok, r.error).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    expect(cfg.mcpServers?.xbus).toBeDefined();
    expect(cfg.mcpServers!.xbus[XBUS_OWNER_TAG]).toBeTruthy();
    // points at the INSTALLED server entry
    expect((cfg.mcpServers!.xbus.args as string[]).some((a) => a.includes(path.join('plugin', 'dist', 'channel', 'server.js')) || a.includes('server.js'))).toBe(true);
    // manifest carries the userScope record + installId
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'install-manifest.json'), 'utf8'));
    expect(manifest.installId).toBeTruthy();
    expect(manifest.userScope.configPath).toBe(configPath);
  });

  it('preserves the user’s pre-existing mcp servers + top-level keys', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { mine: { command: 'c', args: [] } }, theme: 'dark' }, null, 2));
    const r = await install({ source: REPO, installRoot: root, dataDir, claudeConfigPath: configPath, nodePath: process.execPath });
    expect(r.ok, r.error).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    expect(cfg.mcpServers!.mine).toEqual({ command: 'c', args: [] }); // untouched
    expect((cfg as Record<string, unknown>).theme).toBe('dark');
    expect(cfg.mcpServers!.xbus).toBeDefined();
  });

  it('uninstall removes ONLY the XBus entries, leaving the user’s config intact', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { mine: { command: 'c', args: [] } } }, null, 2));
    await install({ source: REPO, installRoot: root, dataDir, claudeConfigPath: configPath, nodePath: process.execPath });
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus).toBeDefined();
    const u = uninstall({ installRoot: root });
    expect(u.ok).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    expect(cfg.mcpServers!.xbus).toBeUndefined(); // ours gone
    expect(cfg.mcpServers!.mine).toEqual({ command: 'c', args: [] }); // theirs kept
  });

  it('registerUserScope:false performs a plugin-only install (no config touched)', async () => {
    const r = await install({ source: REPO, installRoot: root, dataDir, claudeConfigPath: configPath, registerUserScope: false });
    expect(r.ok, r.error).toBe(true);
    expect(fs.existsSync(configPath)).toBe(false); // never created
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'install-manifest.json'), 'utf8'));
    expect(manifest.userScope).toBeUndefined();
  });

  it('a user-scope conflict (unowned xbus key) rolls back the WHOLE install', async () => {
    // Pre-seed an UNOWNED xbus mcp entry → registerUserScope refuses → install rolls back.
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { xbus: { command: 'someoneElse', args: [] } } }, null, 2));
    const r = await install({ source: REPO, installRoot: root, dataDir, claudeConfigPath: configPath, nodePath: process.execPath });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    // plugin dir + manifest removed by rollback
    expect(fs.existsSync(path.join(root, 'install-manifest.json'))).toBe(false);
    // the user's pre-existing entry is intact (we refused to clobber it)
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus.command).toBe('someoneElse');
  });
});
