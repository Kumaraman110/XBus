/**
 * Beta.8 (ADR 0027) — durable logical identity: the FIX.
 *
 * A successor under a NEW Claude Code session id that presents the broker-minted ownerSecret
 * reclaims the durable identity's NAME + INBOX with zero row movement (it is redirected onto
 * the canonical session id via the tested supersede path). Security + lifecycle gates:
 *  - wrong / absent secret ⇒ NO reclaim (beta.7 pending), nameReclaimFailed surfaced;
 *  - a LIVE incumbent (still has a live mcp component) is NEVER evicted ⇒ NO reclaim;
 *  - the owner secret is STABLE across reclaims (no self-lockout);
 *  - the plaintext secret never appears in the audit_events table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { Reaper } from '../../src/broker/reaper.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { DeliveryState } from '../../src/protocol/states.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock; let reaper: Reaper;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-reclaimfix-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('m'), 'b');
  reaper = new Reaper(db, clock, new SeqIdGen('r'));
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function reg(over: Partial<Parameters<BrokerStore['register']>[0]> = {}): SessionAuthority {
  const s = over.sessionId ?? sid();
  return store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...over });
}
function nameState(sessionId: string): { state: string; name: string | null } {
  return db.prepare('SELECT session_name_state AS state, session_name AS name FROM sessions WHERE session_id=?').get(sessionId) as { state: string; name: string | null };
}
function queuedFor(sessionId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND state IN (?,?)`).get(sessionId, DeliveryState.QUEUED, DeliveryState.TRANSPORT_WRITTEN) as { n: number }).n;
}
/** Mirror daemon.onConnClose: mark disconnected + close live components (predecessor is GONE). */
function disconnect(sessionId: string): void {
  const now = clock.nowIso();
  db.prepare(`UPDATE sessions SET state='disconnected', bound_connection_id=NULL, last_seen_at=? WHERE session_id=?`).run(now, sessionId);
  db.prepare(`UPDATE component_instances SET state='closed', disconnected_at=? WHERE session_id=? AND state='live'`).run(now, sessionId);
}

describe('durable identity reclaim — the fix', () => {
  it('first name award returns a stable ownerSecret + logicalIdentityId', () => {
    const a = reg({ requestedSessionName: 'seatmap-api' });
    expect(a.sessionNameState).toBe('active');
    expect(a.awardedSessionName).toBe('seatmap-api');
    expect(typeof a.ownerSecret).toBe('string');
    expect(a.ownerSecret!.length).toBeGreaterThan(16);
    expect(a.logicalIdentityId).toBe(a.sessionId); // fresh session: identity == its own id
  });

  it('successor under a NEW id + valid secret reclaims the name AND inherits the queued inbox', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'seatmap-api' });
    const secret = a.ownerSecret!;

    // queue a message to the name → pinned to A (the canonical id)
    const sender = reg({ requestedSessionName: 'ops' });
    store.send(sender, { to: 'seatmap-api', text: 'refresh', kind: 'request', requiresAck: true, requiresReply: true });
    expect(queuedFor(sidA)).toBe(1);

    // A disconnects (crash). Not expired.
    disconnect(sidA);

    // B = same logical agent, NEW runtime id, presents the secret.
    const sidB = sid();
    const b = reg({ sessionId: sidB, requestedSessionName: 'seatmap-api', ownerSecret: secret });

    // B is REDIRECTED onto the canonical id A → owns the name + inbox, no row movement.
    expect(b.sessionId).toBe(sidA);                 // redirected onto canonical identity
    expect(b.sessionNameState).toBe('active');
    expect(b.awardedSessionName).toBe('seatmap-api');
    expect(b.nameReclaimFailed).toBeUndefined();
    expect(queuedFor(sidA)).toBe(1);                // inbox intact on the canonical id
    // name resolves to the canonical identity and B can operate on it.
    const res2 = store.send(sender, { to: 'seatmap-api', text: 'ping', kind: 'request', requiresAck: false, requiresReply: false });
    expect(res2.recipientSessionId).toBe(sidA);
    // physical_session_map records B's new id → canonical.
    const map = db.prepare(`SELECT canonical_session_id AS c FROM physical_session_map WHERE physical_session_id=?`).get(sidB) as { c: string } | undefined;
    expect(map?.c).toBe(sidA);
  });

  it('WRONG secret ⇒ no reclaim (beta.7 pending), nameReclaimFailed=true, predecessor keeps the name', () => {
    const sidA = sid();
    reg({ sessionId: sidA, requestedSessionName: 'payments' });
    disconnect(sidA);
    const b = reg({ requestedSessionName: 'payments', ownerSecret: 'not-the-secret' });
    expect(b.sessionId).not.toBe(sidA);             // NOT redirected
    expect(b.sessionNameState).toBe('pending');
    expect(b.awardedSessionName).toBeNull();
    expect(b.nameReclaimFailed).toBe(true);
    expect(nameState(sidA).state).toBe('active');   // predecessor still owns it
  });

  it('LIVE incumbent is NEVER evicted: valid secret but incumbent still has a live mcp ⇒ no reclaim', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'notify' }); // A stays LIVE (no disconnect)
    const secret = a.ownerSecret!;
    const b = reg({ requestedSessionName: 'notify', ownerSecret: secret });
    expect(b.sessionId).not.toBe(sidA);             // refused — A is live
    expect(b.sessionNameState).toBe('pending');
    expect(b.nameReclaimFailed).toBe(true);
    expect(nameState(sidA).name).toBe('notify');    // live incumbent keeps its name
  });

  it('secret is STABLE across reclaims — a second reclaim with the ORIGINAL secret still works', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'booking' });
    const secret = a.ownerSecret!;
    disconnect(sidA);
    const b = reg({ requestedSessionName: 'booking', ownerSecret: secret });
    expect(b.sessionId).toBe(sidA);
    // b did NOT get a new secret (no rotation) — it reused the stable one.
    expect(b.ownerSecret == null).toBe(true);
    disconnect(sidA);
    // A third generation reclaims again with the SAME original secret.
    const c = reg({ requestedSessionName: 'booking', ownerSecret: secret });
    expect(c.sessionId).toBe(sidA);
    expect(c.awardedSessionName).toBe('booking');
  });

  it('the plaintext ownerSecret never appears in audit_events', () => {
    const a = reg({ requestedSessionName: 'secretcheck' });
    const secret = a.ownerSecret!;
    const hits = (db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE safe_metadata_json LIKE ?`).get(`%${secret}%`) as { n: number }).n;
    expect(hits).toBe(0);
  });

  it('reaper releases name_ownership in the same sweep (no orphan active ownership)', () => {
    const sidA = sid();
    reg({ sessionId: sidA, requestedSessionName: 'legacy' });
    clock.advance(16 * 24 * 60 * 60_000);
    reaper.sweep();
    const own = db.prepare(`SELECT name_state AS s, normalized_name AS n FROM name_ownership WHERE current_session_id=?`).get(sidA) as { s: string; n: string | null } | undefined;
    expect(own?.s).toBe('released');
    expect(own?.n).toBeNull();
    // a fresh session can now take the name.
    const fresh = reg({ requestedSessionName: 'legacy' });
    expect(fresh.sessionNameState).toBe('active');
  });
});
