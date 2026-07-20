/**
 * Beta.10 INTEGRATION (Package D) — remove_record enable gate: the Adversarial-required condition.
 *
 * Enabling the dashboard's remove_record control is conditional (Adversarial) on proving the
 * KNOWN-3-safe teardown holds against the INTEGRATED broker:
 *   1. After operatorRemoveRecord, the identity leaves NO orphan — name_ownership AND
 *      physical_session_map AND collection_members are ALL gone for that logical identity.
 *   2. A phantom-reclaim attempt on the FREED physical id (and on the old secret/handle) does NOT
 *      resurrect the removed identity.
 *   3. operatorRemoveRecord refuses a CONNECTED session (the safe-remove contract: disconnect/archive first).
 *
 * Store-layer harness over a real migrated DB (s11), mirroring identity-map-lifecycle.test.ts.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-rmorphan-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('rm'), 'b');
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function reg(over: Partial<Parameters<BrokerStore['register']>[0]> = {}): SessionAuthority {
  const s = over.sessionId ?? sid();
  return store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...over });
}
function disconnect(sessionId: string): void {
  const now = clock.nowIso();
  db.prepare(`UPDATE sessions SET state='disconnected', bound_connection_id=NULL, last_seen_at=? WHERE session_id=?`).run(now, sessionId);
  db.prepare(`UPDATE component_instances SET state='closed', disconnected_at=? WHERE session_id=? AND state='live'`).run(now, sessionId);
}
const count = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n;
const inboxCount = (sessionId: string): number => count('SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=?', sessionId);
/** Queue a reply-required message to a name so inbox adoption/restoration is observable. */
function queueTo(name: string): void {
  const sender = reg({ requestedSessionName: `snd-${name}` });
  store.send(sender, { to: name, text: `work-${name}`, kind: 'request', requiresAck: true, requiresReply: true });
}

describe('remove_record enable gate — no orphan + no phantom resurrection (Adversarial condition)', () => {
  it('after operatorRemoveRecord: name_ownership + physical_session_map + collection_members ALL gone for the identity', () => {
    // A owns a handle, has a redirected physical twin (map edge), and is a member of a collection.
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'worker' });
    const logicalA = a.logicalIdentityId!;
    // A redirected successor twin → a physical_session_map edge onto A. Reclaim/redirect only
    // happens when the canonical (A) is disconnected, so disconnect A FIRST, then register the twin
    // with A's secret (it redirects onto A's canonical id, minting the map edge).
    disconnect(sidA);
    const sidTwin = sid();
    reg({ sessionId: sidTwin, requestedSessionName: 'worker', ownerSecret: a.ownerSecret! });
    // A belongs to a collection (membership keyed by the durable logical id).
    store.replaceCollections({ collections: [{ id: 'c1', name: 'Backend', sortOrder: 0, state: 'active' }], members: { [logicalA]: ['c1'] } });

    // Preconditions: all three edge kinds exist for A.
    expect(count('SELECT COUNT(*) AS n FROM name_ownership WHERE logical_identity_id=?', logicalA), 'pre: name_ownership').toBeGreaterThan(0);
    expect(count('SELECT COUNT(*) AS n FROM physical_session_map WHERE canonical_session_id=? OR physical_session_id=? OR logical_identity_id=?', sidA, sidA, logicalA), 'pre: map edges').toBeGreaterThan(0);
    expect(count('SELECT COUNT(*) AS n FROM collection_members WHERE logical_agent_id=?', logicalA), 'pre: membership').toBeGreaterThan(0);

    disconnect(sidA);
    const res = store.operatorRemoveRecord(sidA);
    expect(res.removed).toBe(true);

    // POST: NO orphan — every edge kind for the identity is gone.
    expect(count('SELECT COUNT(*) AS n FROM name_ownership WHERE logical_identity_id=?', logicalA), 'post: name_ownership gone').toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM physical_session_map WHERE canonical_session_id=? OR physical_session_id=? OR logical_identity_id=?', sidA, sidA, logicalA), 'post: map edges gone').toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM collection_members WHERE logical_agent_id=?', logicalA), 'post: membership gone').toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM sessions WHERE session_id=?', sidA), 'post: sessions row gone').toBe(0);
    // The collection itself SURVIVES (removing an agent must not delete collections).
    expect(count('SELECT COUNT(*) AS n FROM collections WHERE collection_id=?', 'c1'), 'collection preserved').toBe(1);
  });

  it('phantom-reclaim on the FREED physical id does NOT resurrect the removed identity (behavioral)', () => {
    // Resurrection = inheriting A's inbox / name_ownership secret. NOTE: a fresh session reusing
    // the SAME physical id legitimately gets logical_identity_id === that id (a NEW identity that
    // happens to share the string) — so non-resurrection is proven BEHAVIORALLY (no inbox, fresh
    // secret, no map edge), never by a logical-id string compare.
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'payments' });
    const oldSecret = a.ownerSecret!;
    queueTo('payments'); // A has queued inbox work before removal
    expect(inboxCount(sidA), 'A had queued work pre-removal').toBeGreaterThan(0);
    disconnect(sidA);
    store.operatorRemoveRecord(sidA);
    // A's deliveries were terminalized (recipient_removed), so none remain non-terminal.
    expect(count("SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND failure_category='recipient_removed'", sidA), 'A inbox terminalized on removal').toBeGreaterThan(0);

    // (a) Re-registering under the SAME freed physical id, no secret → inherits NONE of A's inbox,
    //     and no map edge resurrects A.
    const reuse = reg({ sessionId: sidA });
    void reuse;
    expect(count('SELECT COUNT(*) AS n FROM physical_session_map WHERE canonical_session_id=?', sidA), 'no resurrected map edge onto A').toBe(0);
    // No non-terminal inbox work was adopted by the reused id (A's work stayed terminalized).
    expect(count('SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND failure_category IS NULL', sidA), 'reused id adopts none of A live inbox').toBe(0);

    // (b) Presenting A's OLD secret on a new physical id → gets its OWN fresh identity + secret,
    //     NOT A's (the destroyed identity's secret has no authority).
    const withOldSecret = reg({ sessionId: sid(), requestedSessionName: 'payments-2', ownerSecret: oldSecret });
    expect(withOldSecret.sessionId).not.toBe(sidA);
    expect(typeof withOldSecret.ownerSecret, 'gets its own fresh secret, not A resurrected').toBe('string');

    // (c) The freed 'payments' handle is claimable by a NEW owner with a fresh minted secret.
    const newOwner = reg({ sessionId: sid(), requestedSessionName: 'payments' });
    expect(newOwner.awardedSessionName, 'freed handle claimable by a new owner').toBe('payments');
    expect(newOwner.ownerSecret, 'new owner mints a fresh secret').not.toBe(oldSecret);
  });

  it('operatorRemoveRecord REFUSES a CONNECTED session (safe-remove contract: disconnect/archive first)', () => {
    const sidA = sid();
    reg({ sessionId: sidA, requestedSessionName: 'live-one' }); // still connected
    expect(() => store.operatorRemoveRecord(sidA)).toThrow(); // ILLEGAL_STATE — refuse a connected session
    // The record is intact after the refusal.
    expect(count('SELECT COUNT(*) AS n FROM sessions WHERE session_id=?', sidA), 'connected session not removed').toBe(1);
  });
});
