/**
 * REPRODUCTION — durable-logical-identity / session-continuity defect (beta.7).
 *
 * Confirmed failure (CYF-Infra, SessionToken): an original Claude Code session owns a
 * stable name and a queued inbox; the runtime then presents a DIFFERENT session id for
 * what is logically the same agent (resume with a new id / --fork-session / /clear that
 * re-mints the id / crash-recreate). The predecessor's `sessions` row is still `active`
 * (disconnect does NOT release the name and does NOT shorten the 15-day expiry), so:
 *   • the replacement's name claim hits the taken-branch (store.ts:210-216) and is parked
 *     in `pending` — which reserves NOTHING (markPending NULLs the name, store.ts:240-243);
 *   • register() STILL returns success (a full SessionAuthority) with sessionNameState
 *     'pending' and awardedSessionName null (store.ts:407-411);
 *   • the queued messages stay pinned to the predecessor's session_id
 *     (deliveries.recipient_session_id frozen at send, store.ts:900-909) — stranded;
 *   • the name still resolves to the predecessor (resolveRecipient requires state='active'
 *     AND expired_at IS NULL, store.ts:784), so new sends pile onto the dead id too.
 *
 * ROOT CAUSE: the durable logical identity IS the raw CLAUDE_CODE_SESSION_ID — name,
 * aliases, inbox, threads, deliveries and receipts all hang off `sessions.session_id`
 * (migrations.ts:35, 94-98, 340-342). The epoch/generation/fencing machinery
 * (active_epoch, session_epochs.epoch_token_hash, component_instances) is real, but it
 * only supersedes a new CONNECTION under the SAME session_id; there is NO identity layer
 * ABOVE session_id, and NO ownership-proof a successor under a NEW id can present to
 * reclaim a name + inbox. See docs/adr/0027 (beta.8) for the fix design.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS A CHARACTERIZATION TEST. Every `it()` asserts the CURRENT (broken) beta.7
 * behavior so the suite is GREEN on beta.7 and empirically PROVES the defect exists. Each
 * broken assertion carries a `POST-FIX:` comment with the behavior Phase 2 must deliver;
 * when the durable-identity fix lands, these assertions get flipped to the POST-FIX
 * expectation (and this header note is removed). Do not "fix" the assertions here without
 * the corresponding store change — a green flip with no code change would be a false pass.
 * ────────────────────────────────────────────────────────────────────────────────────
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
// Distinct first-8-hex prefixes so the automatic fallback alias never collides (aliases.ts).
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-reclaim-'));
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
function nameState(sessionId: string): { state: string; name: string | null; normalized: string | null } {
  return db.prepare('SELECT session_name_state AS state, session_name AS name, normalized_session_name AS normalized FROM sessions WHERE session_id=?').get(sessionId) as { state: string; name: string | null; normalized: string | null };
}
/** Non-terminal ("still in the inbox") deliveries addressed to a session id. */
function queuedFor(sessionId: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND state IN (?,?)`,
  ).get(sessionId, DeliveryState.QUEUED, DeliveryState.TRANSPORT_WRITTEN) as { n: number }).n;
}
/** Simulate a clean disconnect at the store layer, exactly as daemon.onConnClose does
 *  (state='disconnected', binding cleared, live components closed) WITHOUT expiring the row. */
function disconnect(sessionId: string): void {
  const now = clock.nowIso();
  db.prepare(`UPDATE sessions SET state='disconnected', bound_connection_id=NULL, last_seen_at=? WHERE session_id=?`).run(now, sessionId);
  db.prepare(`UPDATE component_instances SET state='closed', disconnected_at=? WHERE session_id=? AND state='live'`).run(now, sessionId);
}

describe('durable logical identity: a replacement under a NEW session id reclaims a disconnected predecessor’s name + inbox', () => {
  it('the core defect: replacement is parked pending+null while the stale predecessor keeps the name', () => {
    // A owns a stable name.
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'SeatMap-API' });
    expect(nameState(sidA).state).toBe('active');
    expect(a.awardedSessionName).toBe('SeatMap-API');

    // A third session queues a message to the name → pinned to A's session id.
    const sender = reg({ requestedSessionName: 'ops-sender' });
    const res = store.send(sender, { to: 'SeatMap-API', text: 'refresh Q3 pricing', kind: 'request', requiresAck: true, requiresReply: true });
    expect(res.recipientSessionId).toBe(sidA);
    expect(queuedFor(sidA)).toBe(1);

    // A disconnects (crash / terminal close). NOT expired.
    disconnect(sidA);

    // Well under the 15-day retention → reaper must NOT expire A. Proves the block is a
    // logic gap, not mere retention latency.
    clock.advance(60 * 60_000); // 1 hour
    reaper.sweep();
    expect(nameState(sidA).state).toBe('active'); // predecessor still owns the name

    // B is the SAME logical agent resuming under a NEW runtime session id, asking for its name back.
    const sidB = sid();
    const b = reg({ sessionId: sidB, requestedSessionName: 'SeatMap-API' });

    // ── CURRENT beta.7 behavior (the defect) ──────────────────────────────────────────
    expect(nameState(sidB).state).toBe('pending');        // POST-FIX: 'active'
    expect(b.sessionNameState).toBe('pending');            // POST-FIX: 'active'
    expect(b.awardedSessionName).toBeNull();               // POST-FIX: 'SeatMap-API'
    // The queued message never follows to B — it is stranded on the dead predecessor id.
    expect(queuedFor(sidB)).toBe(0);                       // POST-FIX: 1 (inbox inherited)
    expect(queuedFor(sidA)).toBe(1);                       // POST-FIX: 0 (re-homed to B)
    // The name still resolves to the DEAD predecessor, so fresh sends pile onto sidA too.
    const res2 = store.send(sender, { to: 'SeatMap-API', text: 'ping', kind: 'request', requiresAck: false, requiresReply: false });
    expect(res2.recipientSessionId).toBe(sidA);            // POST-FIX: sidB
  });

  it('register() reports SUCCESS even though the name was not awarded (silent pending)', () => {
    reg({ requestedSessionName: 'payments-svc' }); // predecessor holds it (still active)
    // Replacement under a new id — register returns a full authority (no throw, epoch>=1)…
    const b = reg({ requestedSessionName: 'payments-svc' });
    expect(b.epoch).toBeGreaterThanOrEqual(1);             // success is reported
    // …yet the name is null/pending. A client that only checks "did register succeed?"
    // believes it owns 'payments-svc'. This is the "registration may report success while
    // sessionName remains pending/null" symptom.
    expect(b.sessionNameState).toBe('pending');            // POST-FIX with valid proof: 'active'
    expect(b.awardedSessionName).toBeNull();               // POST-FIX with valid proof: 'payments-svc'
  });

  it('no ownership-proof exists: there is no register field a successor can present to prove continuity', () => {
    // The register input schema has no owner-secret / continuity-token concept today, so a
    // legitimate successor has no way to distinguish itself from a hostile name-grabber.
    // We assert the ABSENCE structurally: even a byte-identical re-request under a new id
    // cannot reclaim. (POST-FIX: register accepts an ownerSecret/continuityToken and, when
    // it matches the name's logical identity, re-points name + inbox to the new id.)
    const a = reg({ requestedSessionName: 'notify-worker' });
    disconnect(a.sessionId);
    const b = reg({ requestedSessionName: 'notify-worker' });
    expect(b.awardedSessionName).toBeNull();               // POST-FIX (with proof): 'notify-worker'
  });

  it('reply to a moved sender strands too: a reply targets the frozen sender_session_id', () => {
    // Sender A opens correspondence, then A moves to a new id B. A reply from the peer is
    // routed to A's frozen sender_session_id, not to B — so B never sees the reply.
    const sidA = sid();
    const a = reg({ sessionId: sidA, requestedSessionName: 'booking-core' });
    const peer = reg({ requestedSessionName: 'peer-svc' });
    // A sends to peer (so a reply would come back to A).
    store.send(a, { to: 'peer-svc', text: 'need a hold', kind: 'request', requiresAck: false, requiresReply: true });
    disconnect(sidA);
    // A resumes as B under a new id, reclaims (tries to) the name.
    const sidB = sid();
    reg({ sessionId: sidB, requestedSessionName: 'booking-core' });
    // Any reply the peer produces is bound to sidA (frozen at send). Assert the frozen
    // linkage that causes the strand: the original message's sender is sidA, not sidB.
    const orig = db.prepare(`SELECT sender_session_id AS s FROM messages WHERE recipient_session_id=?`).get(peer.sessionId) as { s: string } | undefined;
    expect(orig?.s).toBe(sidA);                            // POST-FIX: replies follow the logical identity to sidB
  });
});

describe('scenario matrix: which lifecycle transitions strand identity on beta.7', () => {
  // Same-id resume (unexpired) is the ONE case that works today — it is a passive join
  // that keeps epoch + name + inbox. This is the control: it MUST stay working post-fix.
  it('SAME-id resume (unexpired) keeps the name + inbox (control — works today, must not regress)', () => {
    const s = sid();
    const a = reg({ sessionId: s, requestedSessionName: 'legacy-sync', connectionId: 'c1' });
    const sender = reg({ requestedSessionName: 'sender-x' });
    store.send(sender, { to: 'legacy-sync', text: 'sync now', kind: 'request', requiresAck: true, requiresReply: false });
    expect(queuedFor(s)).toBe(1);
    disconnect(s);
    // Same id reconnects on a new connection (no supersede) → passive join, same epoch.
    const a2 = reg({ sessionId: s, requestedSessionName: 'legacy-sync', connectionId: 'c2' });
    expect(a2.epoch).toBe(a.epoch);            // same epoch (join, not a new lifecycle)
    expect(nameState(s).state).toBe('active'); // name retained
    expect(nameState(s).name).toBe('legacy-sync');
    expect(queuedFor(s)).toBe(1);              // inbox retained
  });

  // A genuinely NEW id (fork / restart-new-id / clear-new-id / crash-recreate) is the
  // defect class. One representative case is enough at the store layer; the fix is common.
  it('NEW-id replacement (fork/restart/clear/recreate) cannot reclaim (the defect class)', () => {
    const sidA = sid();
    reg({ sessionId: sidA, requestedSessionName: 'rogue-parent' });
    disconnect(sidA);
    const sidB = sid(); // fork/restart under a fresh id
    const b = reg({ sessionId: sidB, requestedSessionName: 'rogue-parent' });
    expect(b.awardedSessionName).toBeNull();   // POST-FIX (with proof): 'rogue-parent'
    expect(nameState(sidB).state).toBe('pending');
  });
});
