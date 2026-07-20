/**
 * Beta.10 Stage 0, Part A — ADR-0027 D7 ledger debt fix. The identity-AUTHORITY transitions
 * (cross-id reclaim, expired-resume, rename) are now written to the HASH-CHAINED ledger_events
 * (were best-effort audit()). Covers S0-A1/A2 (events in the chain), S0-A3 (rejection stays on
 * audit), S0-A6 (no secret/body in payload), and the D7 invariant that the ownerSecret never
 * lands in the ledger. Uses the store-layer register harness (mirrors session-identity-reclaim).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import type { SessionAuthority } from '../../src/broker/store.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-d7-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('m'), 'b');
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function reg(over: Partial<Parameters<BrokerStore['register']>[0]> = {}): SessionAuthority {
  const s = over.sessionId ?? sid();
  return store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...over });
}
function ledgerTypes(): string[] {
  return (db.prepare('SELECT event_type FROM ledger_events ORDER BY seq').all() as Array<{ event_type: string }>).map((r) => r.event_type);
}
function ledgerRows(eventType: string): Array<{ actor: string; subject_json: string; payload_json: string }> {
  return db.prepare('SELECT actor, subject_json, payload_json FROM ledger_events WHERE event_type=?').all(eventType) as Array<{ actor: string; subject_json: string; payload_json: string }>;
}
function auditTypes(): string[] {
  return (db.prepare('SELECT event_type FROM audit_events').all() as Array<{ event_type: string }>).map((r) => r.event_type);
}

describe('Stage 0 Part A — D7: identity-authority events are hash-chained (ledger_events), not audit()', () => {
  it('S0-A1: a cross-id reclaim writes identity.reclaimed to the hash-chained ledger', () => {
    const a = reg();
    const name = 'builder-x';
    const named = store.renameSession(a, name);
    expect(named.state).toBe('active');
    const secret = named.ownerSecret!;
    // Disconnect the incumbent so a successor under a NEW id can reclaim.
    db.prepare(`UPDATE sessions SET state='disconnected', bound_connection_id=NULL WHERE session_id=?`).run(a.sessionId);
    db.prepare(`UPDATE component_instances SET state='closed' WHERE session_id=? AND state='live'`).run(a.sessionId);
    reg({ requestedSessionName: name, ownerSecret: secret }); // successor reclaims cross-id

    expect(ledgerTypes()).toContain('identity.reclaimed');
    // It is NOT (only) on the non-chained audit path.
    const rows = ledgerRows('identity.reclaimed');
    expect(rows.length).toBe(1);
    // actor = the canonical (durable) identity reclaimed onto; payload carries ids only.
    expect(rows[0].actor).toBe(a.sessionId);
    expect(rows[0].payload_json).toMatch(/physicalSessionId/);
  });

  it('S0-A2: a rename writes session.rename to the ledger', () => {
    const a = reg();
    store.renameSession(a, 'renamed-svc');
    expect(ledgerTypes()).toContain('session.rename');
    expect(ledgerRows('session.rename')[0].actor).toBe(a.sessionId);
  });

  it('S0-A6 + D7 invariant: the ownerSecret NEVER appears in ledger_events or audit_events', () => {
    const a = reg();
    const named = store.renameSession(a, 'secret-holder');
    const secret = named.ownerSecret!;
    expect(secret.length).toBeGreaterThan(16);
    const allLedger = JSON.stringify(db.prepare('SELECT * FROM ledger_events').all());
    const allAudit = JSON.stringify(db.prepare('SELECT * FROM audit_events').all());
    expect(allLedger).not.toContain(secret);
    expect(allAudit).not.toContain(secret);
  });

  it('S0-A3: SESSION_ALREADY_ACTIVE (a throw+rollback rejection) is NOT hash-chained', () => {
    // A second LIVE mcp on the same session id + different connection is rejected (split-brain
    // guard). Because it throws + rolls back, ledgering it would vanish — it must NOT be a ledger
    // event type. (It is best-effort audit() only, and even that rolls back — documented as
    // "rejected takeovers not durably auditable in M1".)
    const a = reg();
    let threw = false;
    try {
      store.register({ sessionId: a.sessionId, instanceId: 'i2', connectionId: 'other-conn', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
    } catch { threw = true; }
    expect(threw).toBe(true);
    expect(ledgerTypes()).not.toContain('SESSION_ALREADY_ACTIVE');
    expect(ledgerTypes()).not.toContain('session.already_active');
  });

  it('COMPONENT_REGISTERED stays on audit() (routine join, not an authority transition)', () => {
    reg();
    // Not promoted to the ledger (per the Adversarial-confirmed decision).
    expect(ledgerTypes()).not.toContain('COMPONENT_REGISTERED');
    // still recorded on the best-effort audit path.
    expect(auditTypes()).toContain('COMPONENT_REGISTERED');
  });
});
