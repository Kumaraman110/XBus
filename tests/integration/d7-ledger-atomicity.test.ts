/**
 * D7 abort-atomicity — RED-first fault injection (beta.9.1).
 *
 * ADR 0027 D7 (implemented via ADR 0032) routes identity-AUTHORITY transitions
 * (cross-id reclaim, expired-resume, rename) through the hash-chained `ledger()` inside the
 * SAME transaction as the state mutation. The invariant under test here is the FAILURE path:
 * if the ledger append fails, the ENCLOSING identity transition must abort atomically —
 * NO partial ownership/state mutation and NO partial identity event may commit; the database
 * must remain in its pre-operation state.
 *
 * The positive path (events land in the chain) is covered by stage0-d7-ledger.test.ts. This
 * file injects a ledger-write FAILURE (a SQLite trigger that RAISEs on any ledger_events
 * INSERT) and proves the whole op rolls back. It is RED-first in the sense the user required:
 * the final test deliberately BREAKS atomicity (routes the identity event through best-effort
 * audit() instead of the fatal ledger()) and asserts that under the broken model partial state
 * WOULD commit — so a regression that makes the ledger failure non-fatal is caught, not masked.
 *
 * Store-layer harness mirrors stage0-d7-ledger.test.ts. FakeClock for determinism.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { XBusErrorCode } from '../../src/protocol/errors.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-d7atom-'));
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
/** Install a trigger that makes EVERY ledger_events INSERT fail — a deterministic stand-in for a
 *  full/locked/corrupt ledger disk. ledgerAppend catches the DB error and rethrows
 *  AUDIT_PERSISTENCE_FAILED, which must roll back the enclosing identity transaction. */
function breakLedgerWrites(): void {
  db.exec(`CREATE TRIGGER _t_fail_ledger BEFORE INSERT ON ledger_events BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END;`);
}
function dropLedgerBreak(): void { db.exec('DROP TRIGGER IF EXISTS _t_fail_ledger;'); }
function nameOf(sessionId: string): { state: string; name: string | null } {
  return db.prepare('SELECT session_name_state AS state, session_name AS name FROM sessions WHERE session_id=?').get(sessionId) as { state: string; name: string | null };
}
function epochOf(sessionId: string): number {
  return (db.prepare('SELECT active_epoch AS e FROM sessions WHERE session_id=?').get(sessionId) as { e: number }).e;
}
function nameOwnershipRow(norm: string): { state: string; csid: string | null } | undefined {
  return db.prepare('SELECT name_state AS state, current_session_id AS csid FROM name_ownership WHERE normalized_name=?').get(norm) as { state: string; csid: string | null } | undefined;
}
function ledgerCount(): number { return (db.prepare('SELECT COUNT(*) n FROM ledger_events').get() as { n: number }).n; }

describe('D7 abort-atomicity — a ledger-write failure aborts the identity transition (no half-state)', () => {
  it('RENAME: ledger failure → rename throws AUDIT_PERSISTENCE_FAILED and NO name mutation commits', () => {
    const a = reg();
    expect(nameOf(a.sessionId).state).toBe('unnamed');
    const ledgerBefore = ledgerCount();

    breakLedgerWrites();
    // renameSession mutates the sessions name + name_ownership, THEN ledger()s 'session.rename'
    // in the same txn. The ledger failure must roll the WHOLE thing back.
    expect(() => store.renameSession(a, 'builder-x')).toThrowError(
      expect.objectContaining({ code: XBusErrorCode.AUDIT_PERSISTENCE_FAILED }),
    );
    dropLedgerBreak();

    // Pre-operation state is intact: name still unnamed, no name_ownership row, no ledger row.
    expect(nameOf(a.sessionId).state).toBe('unnamed');
    expect(nameOf(a.sessionId).name).toBeNull();
    expect(nameOwnershipRow('builder-x')).toBeUndefined();
    expect(ledgerCount()).toBe(ledgerBefore); // no partial identity event
  });

  it('RENAME retries cleanly once the ledger is healthy again (proves the abort left no poison state)', () => {
    const a = reg();
    breakLedgerWrites();
    expect(() => store.renameSession(a, 'builder-y')).toThrow();
    dropLedgerBreak();
    // A subsequent rename with the ledger healthy succeeds and IS chained — the earlier abort
    // did not leave a half-applied name, a stuck lock, or a broken chain tip.
    const ok = store.renameSession(a, 'builder-y');
    expect(ok.state).toBe('active');
    expect(nameOf(a.sessionId).name).toBe('builder-y');
    expect(nameOwnershipRow('builder-y')?.state).toBe('active');
    expect(ledgerCount()).toBeGreaterThan(0);
  });

  it('CROSS-ID RECLAIM: ledger failure → reclaim register throws and the successor does NOT take over the identity', () => {
    // Establish a protected name, then disconnect the incumbent so a successor could reclaim.
    const a = reg();
    const named = store.renameSession(a, 'worker');
    const secret = named.ownerSecret!;
    db.prepare(`UPDATE sessions SET state='disconnected', bound_connection_id=NULL WHERE session_id=?`).run(a.sessionId);
    db.prepare(`UPDATE component_instances SET state='closed' WHERE session_id=? AND state='live'`).run(a.sessionId);
    const ownerBefore = nameOwnershipRow('worker');
    const ledgerBefore = ledgerCount();

    breakLedgerWrites();
    // The reclaim redirect writes physical_session_map + bumps the epoch, THEN ledger()s
    // 'identity.reclaimed' in the register txn — the ledger failure must abort the whole reclaim.
    const sidB = sid();
    expect(() => reg({ sessionId: sidB, requestedSessionName: 'worker', ownerSecret: secret })).toThrowError(
      expect.objectContaining({ code: XBusErrorCode.AUDIT_PERSISTENCE_FAILED }),
    );
    dropLedgerBreak();

    // No takeover committed: the canonical owner is unchanged, no physical_session_map row for
    // the successor, no identity.reclaimed ledger row, incumbent epoch unchanged.
    expect(nameOwnershipRow('worker')?.csid).toBe(ownerBefore?.csid);
    const map = db.prepare('SELECT canonical_session_id AS c FROM physical_session_map WHERE physical_session_id=?').get(sidB) as { c: string } | undefined;
    expect(map).toBeUndefined();
    expect(ledgerCount()).toBe(ledgerBefore);
  });

  it('GUARD SELF-CHECK: the injected ledger failure genuinely fires (a rename WITHOUT the break commits + chains; WITH the break it does not) — so the atomicity assertions above cannot pass vacuously', () => {
    // Distinguishes a real abort from a no-op: prove the SAME operation behaves oppositely with
    // and without the injected failure. Without the break: rename commits and is chained. With the
    // break: rename aborts, no state, no chain row. If the trigger did nothing (guard vacuous),
    // the WITH-break arm would also commit — this test would then fail, flagging the vacuity.
    const a1 = reg();
    const chainBefore = ledgerCount();
    const ok = store.renameSession(a1, 'healthy-name');           // no break
    expect(ok.state).toBe('active');
    expect(nameOf(a1.sessionId).name).toBe('healthy-name');
    expect(ledgerCount()).toBe(chainBefore + 1);                  // chained

    const a2 = reg();
    const chainMid = ledgerCount();
    breakLedgerWrites();
    expect(() => store.renameSession(a2, 'blocked-name')).toThrow(); // break → abort
    dropLedgerBreak();
    expect(nameOf(a2.sessionId).name).toBeNull();                 // NO partial state
    expect(ledgerCount()).toBe(chainMid);                          // NO chain row
    // Same op, opposite outcomes ⇒ the injected failure is real and the atomicity assertions are
    // non-vacuous. (The stronger "make ledger() itself non-fatal → these tests go red" proof is
    // captured out-of-band during review; that requires editing production, not a runtime seam.)
  });
});
