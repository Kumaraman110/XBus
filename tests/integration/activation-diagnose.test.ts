/**
 * BETA.10 (ADR 0036) — Stop-hook activation diagnosis at the store layer. Exercises the exact
 * correctness properties the reviewers required, in-process (HOSTED_SAFE: temp SQLite + in-process
 * BrokerStore, no host spawn):
 *  1-2. idempotent + at-most-one audit per (session, epoch) even on repeated diagnosis.
 *  3.   surviving a broker restart (reopen the same DB) does NOT re-emit for the same (session,epoch).
 *  4.   a NEW epoch (register a fresh lifecycle) may emit a new warning.
 *  5.   a healthy mcp-registered session NEVER yields PLUGIN_NOT_LOADED (no false-positive on the
 *       documented hook-before-mcp race — mcp registering AFTER the hook still classifies CONNECTED).
 *  6.   an mcp that registered then dropped (state!=live) is MCP_DISCONNECTED, not PLUGIN_NOT_LOADED.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { ComponentRole } from '../../src/identity/components.js';

let dir: string; let dbPath: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-activ-'));
  dbPath = path.join(dir, 'x.sqlite');
  db = openDatabase(dbPath, { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('m'), 'b');
});
afterEach(() => { try { db.close(); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

/** Register a HOOK component for a session (what the lifecycle hook does at SessionStart). */
function registerHook(sessionId: string): SessionAuthority {
  return store.register({ sessionId, instanceId: 'h', connectionId: `hc-${sessionId}-${n}`, processId: 1, projectId: 'proj-hook', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: ComponentRole.HOOK });
}
/** Register an MCP component for a session (what the plugin's MCP server does when it loads). */
function registerMcp(sessionId: string, name?: string): SessionAuthority {
  return store.register({ sessionId, instanceId: 'm', connectionId: `mc-${sessionId}-${n}`, processId: 2, projectId: 'proj-x', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: ComponentRole.MCP, ...(name ? { requestedSessionName: name } : {}) });
}
function auditCount(sessionId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type='PLUGIN_NOT_LOADED' AND actor_session_id=?`).get(sessionId) as { n: number }).n;
}

describe('diagnoseActivationOnce — Stop-hook activation classification + once-only audit', () => {
  it('property 5: a healthy session whose MCP registered (even AFTER the hook) is CONNECTED, never PLUGIN_NOT_LOADED', () => {
    const s = sid();
    registerHook(s);            // hook first (SessionStart)
    registerMcp(s);             // mcp registers LATER (the documented race) — still same epoch
    const d = store.diagnoseActivationOnce(s);
    expect(d.state).toBe('CONNECTED');
    expect(d.firstEmission).toBe(false);
    expect(auditCount(s)).toBe(0);
  });

  it('property: a genuinely bare-claude session (hook only, mcp never) → DEGRADED_HOOK_ONLY + emits ONCE', () => {
    const s = sid();
    registerHook(s);
    const d = store.diagnoseActivationOnce(s);
    expect(d.state).toBe('DEGRADED_HOOK_ONLY'); // hook announced but no mcp ever
    expect(d.firstEmission).toBe(true);
    expect(auditCount(s)).toBe(1);
  });

  it('property 1+2: repeated diagnosis emits NO duplicate (at most one audit per (session,epoch))', () => {
    const s = sid();
    registerHook(s);
    const d1 = store.diagnoseActivationOnce(s);
    const d2 = store.diagnoseActivationOnce(s);
    const d3 = store.diagnoseActivationOnce(s);
    expect(d1.firstEmission).toBe(true);
    expect(d2.firstEmission).toBe(false);
    expect(d3.firstEmission).toBe(false);
    expect(auditCount(s)).toBe(1);
  });

  it('property 3: a broker restart (reopen the SAME db) does NOT re-emit for the same (session,epoch)', () => {
    const s = sid();
    registerHook(s);
    expect(store.diagnoseActivationOnce(s).firstEmission).toBe(true);
    db.close();
    // "restart": reopen the same on-disk DB with a fresh store instance.
    db = openDatabase(dbPath, { applyPragmas: true });
    store = new BrokerStore(db, clock, new SeqIdGen('m2'), 'b');
    const again = store.diagnoseActivationOnce(s);
    expect(again.state).toBe('DEGRADED_HOOK_ONLY');
    expect(again.firstEmission).toBe(false); // audit-derived once-only survives restart
    expect(auditCount(s)).toBe(1);
  });

  it('property 4: a NEW epoch (fresh lifecycle) may emit a NEW warning', () => {
    const s = sid();
    registerHook(s);
    expect(store.diagnoseActivationOnce(s).firstEmission).toBe(true);
    expect(auditCount(s)).toBe(1);
    // A real `xclaude` relaunch / new lifecycle bumps the epoch. Simulate via a supersede register.
    store.register({ sessionId: s, instanceId: 'h2', connectionId: `hc2-${s}`, processId: 3, projectId: 'proj-hook', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: ComponentRole.HOOK, supersede: true });
    const d2 = store.diagnoseActivationOnce(s);
    expect(d2.firstEmission).toBe(true); // new epoch → re-diagnose (user ignored the first warning)
    expect(auditCount(s)).toBe(2);
  });

  it('property 6: an mcp that registered then dropped (not live) is MCP_DISCONNECTED, not PLUGIN_NOT_LOADED', () => {
    const s = sid();
    registerHook(s);
    registerMcp(s);
    // Simulate the mcp channel dropping: mark its component non-live (what a disconnect does).
    db.prepare(`UPDATE component_instances SET state='closed' WHERE session_id=? AND role='mcp'`).run(s);
    const d = store.diagnoseActivationOnce(s);
    expect(d.mcpEver).toBe(true);
    expect(d.mcpLive).toBe(false);
    expect(d.state).toBe('MCP_DISCONNECTED');
    expect(d.firstEmission).toBe(false); // MCP_DISCONNECTED does NOT warn (it loaded fine)
    expect(auditCount(s)).toBe(0);
  });

  it('a live mcp session (no hook) is CONNECTED', () => {
    const s = sid();
    registerMcp(s);
    expect(store.diagnoseActivationOnce(s).state).toBe('CONNECTED');
  });
});
