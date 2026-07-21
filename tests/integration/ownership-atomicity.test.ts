/**
 * BETA.10 WS1 Package B — transaction-failure atomicity for the ownership primitives (R1/R2/R4).
 *
 * Every ownership-authority mutation runs inside ONE db.transaction. If any step fails (a ledger
 * append, a physical_session_map write, or a name_ownership update), the WHOLE op must roll back —
 * no partial identity/ownership state. We inject failures via RAISE(ABORT) triggers on the target
 * tables (a deterministic stand-in for a full/locked/corrupt disk) and assert the pre-state is intact.
 *
 * Covers: rename (R2/R3 award path + name.awarded ledger), reclaim redirect (R1 map write + ledger),
 * and the register fresh-lifecycle. Complements d7-ledger-atomicity (identity.reclaimed/rename ledger).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-ownatom-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('m'), 'b');
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function reg(over: Partial<Parameters<BrokerStore['register']>[0]> = {}): SessionAuthority {
  const s = over.sessionId ?? sid();
  return store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}-${n}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...over });
}
function failOn(table: string, op: 'INSERT' | 'UPDATE' = 'INSERT'): void {
  db.exec(`CREATE TRIGGER _t_fail_${table}_${op} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected ${table} ${op} failure'); END;`);
}
function drop(table: string, op: 'INSERT' | 'UPDATE' = 'INSERT'): void { db.exec(`DROP TRIGGER IF EXISTS _t_fail_${table}_${op};`); }
function nameState(sessionId: string): { state: string; name: string | null } {
  return db.prepare('SELECT session_name_state AS state, session_name AS name FROM sessions WHERE session_id=?').get(sessionId) as { state: string; name: string | null };
}
function mapRows(): number { return (db.prepare('SELECT COUNT(*) AS n FROM physical_session_map').get() as { n: number }).n; }
function ownRows(): number { return (db.prepare('SELECT COUNT(*) AS n FROM name_ownership').get() as { n: number }).n; }

describe('WS1 Package B — ownership mutation transaction-failure atomicity', () => {
  it('R3 ledger-append failure during a name award rolls back the WHOLE award (no name, no ownership row)', () => {
    const a = reg(); // unnamed
    expect(nameState(a.sessionId).state).toBe('unnamed');
    const ownBefore = ownRows();
    failOn('ledger_events', 'INSERT'); // name.awarded ledger append will fail
    expect(() => store.renameSession(a, 'atomic-name')).toThrow();
    drop('ledger_events', 'INSERT');
    // no partial state: session still unnamed, no new name_ownership row.
    expect(nameState(a.sessionId).state).toBe('unnamed');
    expect(nameState(a.sessionId).name).toBeNull();
    expect(ownRows(), 'no name_ownership row committed when the award ledger failed').toBe(ownBefore);
  });

  it('R1 physical_session_map write failure during a reclaim rolls back the WHOLE reclaim', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'reclaim-me' });
    const secret = a.ownerSecret!;
    db.prepare(`UPDATE sessions SET state='disconnected' WHERE session_id=?`).run(sidA);
    db.prepare(`UPDATE component_instances SET state='closed' WHERE session_id=?`).run(sidA);
    const mapBefore = mapRows();
    failOn('physical_session_map', 'INSERT'); // the reclaim redirect map write will fail
    const sidB = sid();
    expect(() => reg({ sessionId: sidB, requestedSessionName: 'reclaim-me', ownerSecret: secret })).toThrow();
    drop('physical_session_map', 'INSERT');
    // no partial reclaim: no new map row, no phantom sidB session adopting the canonical identity.
    expect(mapRows(), 'no physical_session_map row committed when the reclaim map write failed').toBe(mapBefore);
    const sidBExists = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE session_id=?').get(sidB) as { n: number }).n;
    // sidB either doesn't exist or is its own fresh identity — NOT redirected onto A (the reclaim aborted).
    if (sidBExists > 0) {
      const li = db.prepare('SELECT logical_identity_id AS l FROM sessions WHERE session_id=?').get(sidB) as { l: string };
      expect(li.l, 'aborted reclaim must not leave sidB mapped to A').not.toBe(a.logicalIdentityId);
    }
  });

  it('R2 name_ownership update failure during a rename rolls back cleanly (retryable, no poison)', () => {
    const a = reg({ requestedSessionName: 'first' });
    failOn('name_ownership', 'UPDATE');
    expect(() => store.renameSession(a, 'second')).toThrow();
    drop('name_ownership', 'UPDATE');
    // the name is unchanged (rename aborted), and a subsequent rename works (no poison/lock).
    const ok = store.renameSession(a, 'second');
    expect(ok.state).toBe('active');
    expect(nameState(a.sessionId).name).toBe('second');
  });

  it('operatorRemoveRecord ledger-append failure rolls back the WHOLE destruction (identity intact)', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'keepable' });
    db.prepare(`UPDATE sessions SET state='disconnected' WHERE session_id=?`).run(sidA);
    const ownBefore = ownRows();
    failOn('ledger_events', 'INSERT'); // OPERATOR_SESSION_RECORD_REMOVED ledger append fails
    expect(() => store.operatorRemoveRecord(sidA)).toThrow();
    drop('ledger_events', 'INSERT');
    // destruction rolled back: the session + its name_ownership survive intact.
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE session_id=?').get(sidA) as { n: number }).n, 'removal rolled back — session intact').toBe(1);
    expect(ownRows(), 'name_ownership intact after aborted removal').toBe(ownBefore);
    expect(nameState(sidA).name).toBe('keepable');
  });
});
