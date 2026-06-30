/**
 * User-scope Claude MCP + hooks config manager (beta.4, ADR 0012 Decision 8).
 *
 * Registers XBus as a user-scope MCP server + lifecycle hooks in the user's Claude
 * config (~/.claude.json or platform equivalent) so plain `claude` discovers XBus
 * with NO --plugin-dir and NO xclaude. Must be: transactional (backup → write →
 * validate → rollback-on-failure), idempotent, ownership-tagged (uninstall removes
 * ONLY entries this install created — never the user's other MCP servers/hooks),
 * conflict-detecting, repairable, and reversible.
 *
 * Tests use a real temp config FILE (so the atomic write/backup/rollback paths run)
 * but never the real ~/.claude.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  registerUserScope, unregisterUserScope, repairUserScope, readClaudeConfig,
  type UserScopeOptions, XBUS_OWNER_TAG,
} from '../../src/cli/user-scope-config.js';

let dir: string; let configPath: string;
const NODE = process.execPath;
const SERVER_JS = 'C:/x/dist/channel/server.js';
const HOOK_JS = 'C:/x/dist/channel/hook-entry.js';

function opts(over: Partial<UserScopeOptions> = {}): UserScopeOptions {
  return {
    configPath,
    nodePath: NODE,
    serverEntry: SERVER_JS,
    hookEntry: HOOK_JS,
    dataDir: 'C:/x/data',
    installId: 'install-abc',
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-usc-'));
  configPath = path.join(dir, 'claude.json');
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function writeConfig(obj: unknown): void { fs.writeFileSync(configPath, JSON.stringify(obj, null, 2)); }

describe('registerUserScope — fresh config', () => {
  it('creates the config file with the XBus MCP server + hooks, ownership-tagged', () => {
    const r = registerUserScope(opts());
    expect(r.ok).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    // MCP server registered under a stable key with the node-path invocation.
    expect(cfg.mcpServers?.xbus).toBeDefined();
    expect(cfg.mcpServers!.xbus.command).toBe(NODE);
    expect(cfg.mcpServers!.xbus.args).toContain(SERVER_JS);
    // Hooks registered for the checkpoint events.
    const hookCmds = JSON.stringify(cfg.hooks ?? {});
    expect(hookCmds).toContain(HOOK_JS);
    // Ownership marker present so uninstall is scoped.
    expect(cfg.mcpServers!.xbus[XBUS_OWNER_TAG]).toBe('install-abc');
  });

  it('dry-run writes NOTHING but reports the intended change', () => {
    const r = registerUserScope(opts({ dryRun: true }));
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(fs.existsSync(configPath)).toBe(false); // nothing written
  });
});

describe('registerUserScope — preserves unrelated config', () => {
  it('keeps the user’s OTHER mcp servers, hooks, and top-level keys intact', () => {
    writeConfig({
      mcpServers: { otherTool: { command: 'othercmd', args: ['x'] } },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] },
      theme: 'dark', model: 'opus',
    });
    const r = registerUserScope(opts());
    expect(r.ok).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    // ours added…
    expect(cfg.mcpServers!.xbus).toBeDefined();
    // …theirs untouched
    expect(cfg.mcpServers!.otherTool).toEqual({ command: 'othercmd', args: ['x'] });
    expect((cfg as Record<string, unknown>).theme).toBe('dark');
    expect((cfg as Record<string, unknown>).model).toBe('opus');
    // the user's own UserPromptSubmit hook entry is still present alongside ours
    expect(JSON.stringify(cfg.hooks)).toContain('user-hook');
  });

  it('backs up the pre-existing config before writing (restorable)', () => {
    writeConfig({ mcpServers: { otherTool: { command: 'x' } } });
    const r = registerUserScope(opts());
    expect(r.ok).toBe(true);
    expect(r.backupPath).toBeTruthy();
    expect(fs.existsSync(r.backupPath!)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(r.backupPath!, 'utf8'));
    expect(backup.mcpServers.otherTool).toBeDefined();
    expect(backup.mcpServers.xbus).toBeUndefined(); // backup is the PRE-install state
  });
});

describe('registerUserScope — idempotence + conflict', () => {
  it('is idempotent: a second register with the SAME install id is a no-op success', () => {
    registerUserScope(opts());
    const first = readClaudeConfig(configPath)!;
    const r2 = registerUserScope(opts());
    expect(r2.ok).toBe(true);
    expect(r2.alreadyRegistered).toBe(true);
    expect(readClaudeConfig(configPath)).toEqual(first); // unchanged
  });

  it('detects a CONFLICTING pre-existing xbus entry owned by a different install', () => {
    writeConfig({ mcpServers: { xbus: { command: 'stale', args: [], [XBUS_OWNER_TAG]: 'OLD-install' } } });
    const r = registerUserScope(opts({ installId: 'NEW-install' }));
    // Default: re-take ownership (repair the stale entry) and report it.
    expect(r.ok).toBe(true);
    expect(r.replacedConflict).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    expect(cfg.mcpServers!.xbus[XBUS_OWNER_TAG]).toBe('NEW-install');
    expect(cfg.mcpServers!.xbus.command).toBe(NODE); // corrected
  });

  it('refuses to clobber a non-XBus-owned entry under the xbus key without force', () => {
    writeConfig({ mcpServers: { xbus: { command: 'someoneElse', args: [] } } }); // NO owner tag
    const r = registerUserScope(opts());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/conflict|not owned|unowned/i);
    // unchanged
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus.command).toBe('someoneElse');
  });
});

describe('registerUserScope — transactional rollback', () => {
  it('a write/validate failure restores the original config exactly', () => {
    writeConfig({ mcpServers: { otherTool: { command: 'x' } }, theme: 'light' });
    const original = fs.readFileSync(configPath, 'utf8');
    // Inject a validator that always fails → must roll back.
    const r = registerUserScope(opts({ validate: () => ({ ok: false, detail: 'forced failure' }) }));
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original); // byte-identical restore
  });
});

describe('unregisterUserScope — ownership-scoped removal', () => {
  it('removes ONLY the XBus entries this install owns, leaving everything else', () => {
    writeConfig({
      mcpServers: { otherTool: { command: 'othercmd' } },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] },
      theme: 'dark',
    });
    registerUserScope(opts());
    const u = unregisterUserScope(opts());
    expect(u.ok).toBe(true);
    expect(u.removed).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    expect(cfg.mcpServers!.xbus).toBeUndefined(); // ours gone
    expect(cfg.mcpServers!.otherTool).toBeDefined(); // theirs kept
    expect((cfg as Record<string, unknown>).theme).toBe('dark');
    expect(JSON.stringify(cfg.hooks)).toContain('user-hook'); // their hook kept
    expect(JSON.stringify(cfg.hooks)).not.toContain(HOOK_JS); // our hook gone
  });

  it('does NOT remove an xbus entry owned by a DIFFERENT install', () => {
    writeConfig({ mcpServers: { xbus: { command: 'x', [XBUS_OWNER_TAG]: 'OTHER-install' } } });
    const u = unregisterUserScope(opts({ installId: 'mine' }));
    expect(u.ok).toBe(true);
    expect(u.removed).toBe(false); // not ours → not removed
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus).toBeDefined();
  });

  it('uninstall on a config with no xbus entry is a clean no-op', () => {
    writeConfig({ mcpServers: { otherTool: { command: 'x' } } });
    const u = unregisterUserScope(opts());
    expect(u.ok).toBe(true);
    expect(u.removed).toBe(false);
  });
});

describe('repairUserScope', () => {
  it('re-applies the canonical entry when ours has drifted (e.g. node path moved)', () => {
    registerUserScope(opts({ nodePath: 'C:/old/node.exe' }));
    const r = repairUserScope(opts({ nodePath: 'C:/new/node.exe' }));
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus.command).toBe('C:/new/node.exe');
  });

  it('repair when not present registers fresh', () => {
    const r = repairUserScope(opts());
    expect(r.ok).toBe(true);
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus).toBeDefined();
  });
});
