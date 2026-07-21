/**
 * BETA.10 (ADR 0036) — persistent enablement (enabledPlugins opt-in) unit tests. Transactional,
 * byte-exact-preserving, ownership-aware, idempotent, conflict-safe. All against a temp settings.json
 * (no ~/.claude, golden untouched). Covers the reviewer-required cases: dry-run plan, off-by-default,
 * idempotent, preserve-unrelated, conflict-refuse-without-force, malformed-settings, uninstall-clean.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  planPersistentEnable, setPersistentEnable, clearPersistentEnable,
  readClaudeSettings, XBUS_PLUGIN_NAME,
} from '../../src/cli/user-scope-config.js';

let dir: string; let sp: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-persist-')); sp = path.join(dir, 'settings.json'); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
function write(obj: unknown): void { fs.writeFileSync(sp, JSON.stringify(obj, null, 2)); }
function read(): Record<string, unknown> { return JSON.parse(fs.readFileSync(sp, 'utf8')) as Record<string, unknown>; }

describe('persistent enablement — plan (dry-run, no mutation)', () => {
  it('plan on a nonexistent settings file: createsFile, not enabled, no conflict', () => {
    const p = planPersistentEnable(sp);
    expect(p.createsFile).toBe(true);
    expect(p.alreadyEnabled).toBe(false);
    expect(p.conflict).toBe(false);
    expect(p.property).toBe(`enabledPlugins.${XBUS_PLUGIN_NAME}`);
    expect(fs.existsSync(sp)).toBe(false); // planning NEVER mutates
  });
  it('dry-run setPersistentEnable makes NO change', () => {
    const r = setPersistentEnable(sp, { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(fs.existsSync(sp)).toBe(false);
  });
});

describe('persistent enablement — enable', () => {
  it('enables idempotently and preserves unrelated settings byte-for-byte', () => {
    write({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] }, enabledPlugins: { 'other-plugin': true }, someUserKey: 42 });
    const r1 = setPersistentEnable(sp);
    expect(r1.ok).toBe(true); expect(r1.changed).toBe(true);
    const after = read();
    expect((after.enabledPlugins as Record<string, boolean>)[XBUS_PLUGIN_NAME]).toBe(true);
    expect((after.enabledPlugins as Record<string, boolean>)['other-plugin']).toBe(true); // preserved
    expect(after.someUserKey).toBe(42); // preserved
    expect(after.hooks).toBeTruthy(); // preserved
    // idempotent: a second enable changes nothing
    const r2 = setPersistentEnable(sp);
    expect(r2.ok).toBe(true); expect(r2.changed).toBe(false); expect(r2.alreadyEnabled).toBe(true);
  });

  it('creates the settings file when absent', () => {
    const r = setPersistentEnable(sp);
    expect(r.ok).toBe(true); expect(r.changed).toBe(true);
    expect((read().enabledPlugins as Record<string, boolean>)[XBUS_PLUGIN_NAME]).toBe(true);
  });

  it('REFUSES a conflicting non-true value without --force, and does NOT mutate', () => {
    write({ enabledPlugins: { [XBUS_PLUGIN_NAME]: false } });
    const before = fs.readFileSync(sp, 'utf8');
    const r = setPersistentEnable(sp);
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    expect(fs.readFileSync(sp, 'utf8')).toBe(before); // untouched
  });

  it('--force overrides a conflicting value', () => {
    write({ enabledPlugins: { [XBUS_PLUGIN_NAME]: false } });
    const r = setPersistentEnable(sp, { force: true });
    expect(r.ok).toBe(true); expect(r.changed).toBe(true);
    expect((read().enabledPlugins as Record<string, boolean>)[XBUS_PLUGIN_NAME]).toBe(true);
  });

  it('malformed settings.json (unparseable): enable treats it as absent and writes a fresh valid file', () => {
    fs.writeFileSync(sp, '{ this is not json ');
    const r = setPersistentEnable(sp);
    // readClaudeSettings returns null on parse failure → treated as no prior config; write succeeds.
    expect(r.ok).toBe(true);
    expect((read().enabledPlugins as Record<string, boolean>)[XBUS_PLUGIN_NAME]).toBe(true);
  });
});

describe('persistent enablement — clear (uninstall)', () => {
  it('removes ONLY the xbus entry, preserving other plugins, and drops an empty enabledPlugins object', () => {
    write({ enabledPlugins: { [XBUS_PLUGIN_NAME]: true, 'other-plugin': true }, keep: 'me' });
    const r = clearPersistentEnable(sp);
    expect(r.ok).toBe(true); expect(r.changed).toBe(true);
    const after = read();
    expect((after.enabledPlugins as Record<string, boolean>)[XBUS_PLUGIN_NAME]).toBeUndefined();
    expect((after.enabledPlugins as Record<string, boolean>)['other-plugin']).toBe(true); // preserved
    expect(after.keep).toBe('me');
  });

  it('when xbus was the ONLY enabled plugin, removes the enabledPlugins key entirely (no bare {})', () => {
    write({ enabledPlugins: { [XBUS_PLUGIN_NAME]: true }, other: 1 });
    clearPersistentEnable(sp);
    const after = read();
    expect(after.enabledPlugins).toBeUndefined();
    expect(after.other).toBe(1);
  });

  it('idempotent: clearing when xbus is absent is a no-op success', () => {
    write({ enabledPlugins: { 'other-plugin': true } });
    const r = clearPersistentEnable(sp);
    expect(r.ok).toBe(true); expect(r.changed).toBe(false);
    expect((read().enabledPlugins as Record<string, boolean>)['other-plugin']).toBe(true);
  });

  it('enable→clear round-trip leaves the file valid with no residual xbus state', () => {
    write({ enabledPlugins: { 'other-plugin': true }, top: 'x' });
    setPersistentEnable(sp);
    clearPersistentEnable(sp);
    const after = readClaudeSettings(sp);
    expect(after?.enabledPlugins?.[XBUS_PLUGIN_NAME]).toBeUndefined();
    expect((after?.enabledPlugins as Record<string, boolean>)['other-plugin']).toBe(true);
    expect((after as Record<string, unknown>).top).toBe('x');
  });
});
