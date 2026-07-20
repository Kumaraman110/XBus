/**
 * BETA.10 WS1 — identity teardown semantics (Rank 1). Split teardown, user-authorized:
 *   REMOVE  = explicit destruction (GC all map edges, release+DELETE name_ownership, invalidate
 *             secret, unfinished deliveries → 'recipient_removed'; identity unreclaimable).
 *   EXPIRY  = dormancy, NOT deletion (delete transient map rows, PRESERVE logical identity + inbox
 *             + secret-hash + protected handle; mark dormant; valid secret reactivates; secret-less
 *             / wrong-secret never redirects; MUST NOT mark ownership 'released' — handle stays held).
 *   REGISTER defense-in-depth: follow a map edge ONLY when the canonical target exists AND is
 *             redirect-eligible; never secret-lessly redirect to dormant/removed/missing; purge an
 *             invalid stale map transactionally and continue; require secret before dormant reactivation.
 *
 * This is the authorized RED/GREEN matrix (10 cases). RED-first at 6195020 (the split semantics do
 * not exist yet); GREEN after the single ownership-transition service lands. Store-layer harness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority, MEANINGFUL_ACTIVITY_RETENTION_MS } from '../../src/broker/store.js';
import { Reaper } from '../../src/broker/reaper.js';
import { DeliveryState } from '../../src/protocol/states.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock; let reaper: Reaper;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-maplc-'));
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
function disconnect(sessionId: string): void {
  const now = clock.nowIso();
  db.prepare(`UPDATE sessions SET state='disconnected', bound_connection_id=NULL, last_seen_at=? WHERE session_id=?`).run(now, sessionId);
  db.prepare(`UPDATE component_instances SET state='closed', disconnected_at=? WHERE session_id=? AND state='live'`).run(now, sessionId);
}
function mapRowsTo(canonical: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM physical_session_map WHERE canonical_session_id=?').get(canonical) as { n: number }).n;
}
function inboxCount(sessionId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=?`).get(sessionId) as { n: number }).n;
}
/** Queue a reply-required message to a name (so inbox adoption / restoration is observable). */
function queueTo(name: string): void {
  const sender = reg({ requestedSessionName: `snd-${name}` });
  store.send(sender, { to: name, text: `work-${name}`, kind: 'request', requiresAck: true, requiresReply: true });
}

describe('WS1 identity teardown — REMOVE = destruction (RED-first matrix)', () => {
  it('CASE 1 — remove → same physical id, no secret: fresh identity, no inherited inbox', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'worker' });
    queueTo('worker');
    disconnect(sidA);
    const sidB = sid();
    reg({ sessionId: sidB, requestedSessionName: 'worker', ownerSecret: a.ownerSecret! }); // map B->A
    disconnect(sidA);
    store.operatorRemoveRecord(sidA);
    // A brand-new session under physical id B, NO secret: must be its own fresh identity.
    const c = reg({ sessionId: sidB });
    expect(c.sessionId, 'secret-less register must not be redirected onto removed A').toBe(sidB);
    expect(inboxCount(sidB), 'fresh identity inherits none of A inbox').toBe(0);
    expect(mapRowsTo(sidA), 'no map edge survives removal of A').toBe(0);
  });

  it('CASE 2 — remove → old secret: rejected (no reclaim of a destroyed identity)', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'payments' });
    const secret = a.ownerSecret!;
    disconnect(sidA);
    store.operatorRemoveRecord(sidA);
    // Presenting the OLD secret must NOT reclaim the destroyed identity.
    const b = reg({ sessionId: sid(), requestedSessionName: 'payments', ownerSecret: secret });
    expect(b.sessionId, 'old secret has no authority over a removed identity').not.toBe(sidA);
    expect(b.logicalIdentityId, 'must not resolve to the destroyed logical identity').not.toBe(a.logicalIdentityId);
  });

  it('CASE 3 — remove → old handle: normally reclaimable by a NEW owner (fresh secret)', () => {
    const sidA = sid();
    reg({ sessionId: sidA, requestedSessionName: 'notify' });
    disconnect(sidA);
    store.operatorRemoveRecord(sidA);
    // A new session claims the freed handle → gets it active with its OWN fresh secret.
    const c = reg({ sessionId: sid(), requestedSessionName: 'notify' });
    expect(c.awardedSessionName, 'the freed handle is claimable by a new owner').toBe('notify');
    expect(c.sessionNameState).toBe('active');
    expect(typeof c.ownerSecret, 'new owner gets a fresh minted secret').toBe('string');
  });

  it('CASE 4 — remove → unfinished deliveries reach an explicit terminal reason, not silent orphan', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'tasks' });
    queueTo('tasks'); // a queued reply-required delivery to A
    disconnect(sidA);
    store.operatorRemoveRecord(sidA);
    // No delivery to A may remain in a non-terminal state; the terminal reason is explicit.
    const nonTerminal = (db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND state IN (?,?,?,?)`)
      .get(sidA, DeliveryState.QUEUED, DeliveryState.TRANSPORT_WRITTEN, DeliveryState.ACCEPTED, DeliveryState.RETRY_WAIT) as { n: number }).n;
    expect(nonTerminal, 'no unfinished delivery may survive removal as a silent orphan').toBe(0);
    const removedReason = (db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND failure_category='recipient_removed'`).get(sidA) as { n: number }).n;
    expect(removedReason, 'unfinished deliveries carry an explicit recipient_removed terminal reason').toBeGreaterThan(0);
  });
});

describe('WS1 identity teardown — EXPIRY = dormancy not deletion (RED-first matrix)', () => {
  it('CASE 5 — expiry → same physical id, no secret: no redirect (starts fresh/pending, never adopts A)', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'idle-a' });
    queueTo('idle-a');
    disconnect(sidA);
    const sidB = sid();
    reg({ sessionId: sidB, requestedSessionName: 'idle-a', ownerSecret: a.ownerSecret! }); // map B->A
    disconnect(sidA);
    clock.advance(MEANINGFUL_ACTIVITY_RETENTION_MS + 60_000);
    reaper.sweep();
    // A NEW physical id, no secret, must NOT be redirected onto the dormant identity.
    const c = reg({ sessionId: sid() });
    expect(c.sessionId, 'secret-less register must not redirect to a dormant identity').not.toBe(sidA);
    expect(inboxCount(c.sessionId), 'must not inherit the dormant identity inbox').toBe(0);
    expect(mapRowsTo(sidA), 'transient map edges to the dormant identity are purged').toBe(0);
  });

  it('CASE 6 — expiry → wrong secret: no redirect', () => {
    const sidA = sid();
    reg({ sessionId: sidA, requestedSessionName: 'idle-b' });
    disconnect(sidA);
    clock.advance(MEANINGFUL_ACTIVITY_RETENTION_MS + 60_000);
    reaper.sweep();
    const b = reg({ sessionId: sid(), requestedSessionName: 'idle-b', ownerSecret: 'wrong-secret' });
    expect(b.sessionId, 'wrong secret must not reclaim the dormant identity').not.toBe(sidA);
    expect(b.sessionNameState, 'wrong-secret reclaim is pending, not active').not.toBe('active');
  });

  it('CASE 7 — expiry → VALID secret: canonical identity AND inbox restored under a fresh epoch', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'idle-c' });
    const secret = a.ownerSecret!;
    queueTo('idle-c'); // a pending delivery to A's inbox
    const inboxBefore = inboxCount(sidA);
    expect(inboxBefore).toBeGreaterThan(0);
    disconnect(sidA);
    clock.advance(MEANINGFUL_ACTIVITY_RETENTION_MS + 60_000);
    reaper.sweep();
    // Valid secret reclaims the dormant identity: same canonical id + inbox, fresh epoch.
    const r = reg({ sessionId: sid(), requestedSessionName: 'idle-c', ownerSecret: secret });
    expect(r.sessionId, 'valid secret restores the canonical identity').toBe(sidA);
    expect(r.awardedSessionName, 'the protected handle is restored').toBe('idle-c');
    expect(r.epoch, 'reactivation is a fresh epoch').toBeGreaterThan(a.epoch);
    expect(inboxCount(sidA), 'the preserved inbox is restored').toBe(inboxBefore);
  });

  it('CASE 8 — expiry must NOT mark ownership released (handle stays HELD/protected, not takeover-able)', () => {
    const sidA = sid();
    reg({ sessionId: sidA, requestedSessionName: 'idle-d' });
    disconnect(sidA);
    clock.advance(MEANINGFUL_ACTIVITY_RETENTION_MS + 60_000);
    reaper.sweep();
    // The dormant identity still HOLDS its name_ownership (not 'released') so no other identity
    // can take the handle without the secret; the row is preserved with its secret hash.
    const own = db.prepare(`SELECT name_state AS state, owner_secret_hash AS hash FROM name_ownership WHERE normalized_name='idle-d'`).get() as { state: string; hash: string | null } | undefined;
    expect(own, 'dormant identity keeps its name_ownership row').toBeTruthy();
    expect(own!.state, 'expiry must NOT release the handle').not.toBe('released');
    expect(own!.hash, 'the owner secret hash is preserved for reactivation').not.toBeNull();
  });
});

describe('WS1 identity teardown — defense-in-depth + atomicity (RED-first matrix)', () => {
  it('CASE 9 — a stale map to a MISSING/removed target is self-healed (purged) and never followed', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'ghost' });
    disconnect(sidA);
    const sidB = sid();
    reg({ sessionId: sidB, requestedSessionName: 'ghost', ownerSecret: a.ownerSecret! }); // map B->A
    // Simulate a partially-corrupt/upgraded DB: A's sessions row is gone but a stale map edge
    // survives (a schema without the FK, or an out-of-band corruption). The FK normally prevents
    // this, so drop enforcement for just this one setup statement to manufacture the dangling edge
    // the defense-in-depth path must self-heal.
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM sessions WHERE session_id=?').run(sidA);
    db.pragma('foreign_keys = ON');
    // A register under B must NOT follow the dangling edge; it purges it and registers normally.
    const c = reg({ sessionId: sidB });
    expect(c.sessionId, 'a dangling map to a missing target must not be followed').toBe(sidB);
    expect(mapRowsTo(sidA), 'the invalid stale map edge is purged').toBe(0);
  });

  it('CASE 10 — old epoch remains fenced across a reactivation (stale-epoch owner cannot act)', () => {
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'fence-me' });
    const secret = a.ownerSecret!;
    disconnect(sidA);
    clock.advance(MEANINGFUL_ACTIVITY_RETENTION_MS + 60_000);
    reaper.sweep();
    reg({ sessionId: sid(), requestedSessionName: 'fence-me', ownerSecret: secret }); // reactivate → epoch bump
    // The ORIGINAL epoch-1 authority `a` is now stale; an identity op under it must be rejected.
    expect(() => store.renameSession(a, 'hijacked')).toThrow();
  });
});
