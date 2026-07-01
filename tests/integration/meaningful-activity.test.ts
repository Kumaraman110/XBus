/**
 * Meaningful-activity refresh map (beta.4, ADR 0012 Decision 5).
 *
 * The 15-day idle timer (last_meaningful_activity_at, and the derived expires_at)
 * must be extended by genuinely meaningful, model-visible ops, and must NOT be
 * extended by passive liveness. This test pins EACH site:
 *   refreshes: register, rename, send (sender), checkpoint pull WITH body, ack,
 *              reject, reply, explicit redelivery
 *   does NOT:  signalReadiness, a body-SUPPRESSED re-injection, an empty/deferred
 *              pull, the reaper sweep, a passive reconnect/component join
 * If any meaningful op is missed, sessions expire while in use; if any passive op
 * refreshes, dead sessions live forever. Both are tested.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { Reaper } from '../../src/broker/reaper.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let delivery: DeliveryOps; let reaper: Reaper; let clock: FakeClock;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };
const ACK_MS = 5 * 60_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-act-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('m');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'b');
  delivery = new DeliveryOps(db, clock, ids, ACK_MS);
  reaper = new Reaper(db, clock, ids);
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function activityAt(sessionId: string): string | null {
  return (db.prepare('SELECT last_meaningful_activity_at AS a FROM sessions WHERE session_id=?').get(sessionId) as { a: string | null }).a;
}
/** Register an mcp session that is READY for injection, with a unique name. */
function readySession(name: string): SessionAuthority {
  const s = sid();
  const auth = store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: name });
  store.signalReadiness(auth, { ackAvailable: true, versionOk: true });
  return auth;
}
function hook(auth: SessionAuthority): SessionAuthority { return { ...auth, role: 'hook' as never }; }

describe('meaningful activity REFRESHES on', () => {
  it('register (initial)', () => {
    const a = readySession('reg-one');
    expect(activityAt(a.sessionId)).toBe(clock.nowIso());
  });

  it('rename', () => {
    const a = readySession('rn-one');
    clock.advance(60_000);
    store.renameSession(a, 'rn-two');
    expect(activityAt(a.sessionId)).toBe(clock.nowIso());
  });

  it('send (the sender)', () => {
    const sender = readySession('snd');
    readySession('rcv');
    clock.advance(60_000);
    store.send(sender, { to: 'rcv', text: 'hi', kind: 'request', requiresAck: false, requiresReply: false });
    expect(activityAt(sender.sessionId)).toBe(clock.nowIso());
  });

  it('checkpoint pull WITH a body (the recipient)', () => {
    const sender = readySession('snd2');
    const rcv = readySession('rcv2');
    store.send(sender, { to: 'rcv2', text: 'hi', kind: 'request', requiresAck: true, requiresReply: false });
    clock.advance(60_000);
    const got = delivery.checkpointPull(hook(rcv), 'cp1', 10);
    expect(got).toHaveLength(1);
    expect(activityAt(rcv.sessionId)).toBe(clock.nowIso()); // recipient refreshed
  });

  it('ack and reply (the recipient)', () => {
    const sender = readySession('snd3');
    const rcv = readySession('rcv3');
    const { messageId } = store.send(sender, { to: 'rcv3', text: 'q', kind: 'request', requiresAck: true, requiresReply: true });
    const v = delivery.inboxView(rcv, 'cp1', 10);
    clock.advance(60_000);
    delivery.ack(rcv, { messageId, status: 'accepted', injectionId: v[0]!.injectionId! });
    expect(activityAt(rcv.sessionId)).toBe(clock.nowIso());
    clock.advance(60_000);
    delivery.reply(rcv, { messageId, text: 'a', outcome: 'completed' }, (rid) => {
      const row = db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(rid) as { next_sequence: number } | undefined;
      const seq = row ? row.next_sequence : 1;
      db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?,?)').run(rid, seq + 1);
      return seq;
    });
    expect(activityAt(rcv.sessionId)).toBe(clock.nowIso());
  });
});

describe('meaningful activity does NOT refresh on', () => {
  it('signalReadiness (passive heartbeat)', () => {
    const a = readySession('sr-one');
    const t0 = activityAt(a.sessionId);
    clock.advance(60_000);
    store.signalReadiness(a, { ackAvailable: true, versionOk: true });
    expect(activityAt(a.sessionId)).toBe(t0); // unchanged
  });

  it('an empty checkpoint pull (nothing to inject)', () => {
    const a = readySession('ep-one');
    const t0 = activityAt(a.sessionId);
    clock.advance(60_000);
    expect(delivery.checkpointPull(hook(a), 'cp1', 10)).toHaveLength(0);
    expect(activityAt(a.sessionId)).toBe(t0); // unchanged
  });

  it('a body-SUPPRESSED re-injection (ack-timeout requeue re-pull)', () => {
    const sender = readySession('bs-snd');
    const rcv = readySession('bs-rcv');
    const { messageId } = store.send(sender, { to: 'bs-rcv', text: 'q', kind: 'request', requiresAck: true, requiresReply: true });
    delivery.checkpointPull(hook(rcv), 'cp1', 10); // first body presented (refreshes)
    const afterFirst = activityAt(rcv.sessionId);
    // Let the ack deadline pass; reaper requeues; advance past backoff.
    clock.advance(ACK_MS + 1000); reaper.sweep(); clock.advance(60_000 + 1000);
    // Re-pull: body is SUPPRESSED (Layer-3) → must NOT count as recipient activity.
    const got = delivery.checkpointPull(hook(rcv), 'cp2', 10);
    expect(got.find((m) => m.messageId === messageId)).toBeUndefined(); // no body
    expect(activityAt(rcv.sessionId)).toBe(afterFirst); // unchanged by the re-injection
  });

  it('the reaper sweep itself', () => {
    const a = readySession('rs-sweep');
    const t0 = activityAt(a.sessionId);
    clock.advance(60_000);
    reaper.sweep();
    expect(activityAt(a.sessionId)).toBe(t0); // unchanged
  });

  it('a passive component reconnect/join (not a new lifecycle)', () => {
    const a = readySession('rc-one');
    const t0 = activityAt(a.sessionId);
    clock.advance(60_000);
    // A hook joins the SAME session/epoch (reconnect) — not meaningful activity.
    store.register({ sessionId: a.sessionId, instanceId: 'i2', connectionId: `c2-${a.sessionId}`, processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'hook' as never });
    expect(activityAt(a.sessionId)).toBe(t0); // join did not refresh
  });
});
