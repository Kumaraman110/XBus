/**
 * §1 — model-visible duplicate prevention. The full request body must appear ONCE
 * in normal model-visible inbox output; a recovery pull of an already-injected
 * message returns metadata + bodyIncluded:false. Explicit redelivery re-presents
 * the body under a new logical injection number.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let delivery: DeliveryOps; let clock: FakeClock;
const A = 'aaaa0000-0000-4000-8000-00000000000a';
const B = 'bbbb0000-0000-4000-8000-00000000000b';

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-dup-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('d');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'b');
  delivery = new DeliveryOps(db, clock, ids);
}
function pair(): { authA: SessionAuthority; authB: SessionAuthority } {
  const authA = store.register({ sessionId: A, instanceId: 'iA', connectionId: 'cA', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
  store.registerAlias(authA, 'architect');
  const authB = store.register({ sessionId: B, instanceId: 'iB', connectionId: 'cB', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
  store.registerAlias(authB, 'implementer');
  // §2: become ready (the receiving session must accept injection for these tests).
  store.signalReadiness(authA, { ackAvailable: true, versionOk: true });
  store.signalReadiness(authB, { ackAvailable: true, versionOk: true });
  return { authA, authB };
}
const BODY = 'PLEASE-REVIEW-THE-AUTH-CONTRACT-BODY';
function send(authA: SessionAuthority) { return store.send(authA, { to: 'implementer', text: BODY, kind: 'request', requiresAck: true, requiresReply: true }); }

beforeEach(setup);
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('§1 model-visible duplicate prevention', () => {
  it('1+2: first inbox view includes the body exactly once; second pull does NOT repeat it', () => {
    const { authA, authB } = pair();
    send(authA);
    const v1 = delivery.inboxView(authB, 'cp1', 10);
    expect(v1).toHaveLength(1);
    expect(v1[0]!.state).toBe('queued_not_injected');
    expect(v1[0]!.bodyIncluded).toBe(true);
    expect(v1[0]!.text).toBe(BODY);
    // second pull: re-surfaced for recovery but body NOT repeated
    const v2 = delivery.inboxView(authB, 'cp2', 10);
    expect(v2).toHaveLength(1);
    expect(v2[0]!.state).toBe('context_injected_unacknowledged');
    expect(v2[0]!.bodyAlreadyPresented).toBe(true);
    expect(v2[0]!.bodyIncluded).toBe(false);
    expect(v2[0]!.text).toBeUndefined(); // body NOT present
    expect(v2[0]!.injectionId).toBe(v1[0]!.injectionId); // same injection
    expect(v2[0]!.allowedActions).toContain('request-explicit-redelivery');
  });

  it('5: same checkpointId repeated does not re-inject (one injection row)', () => {
    const { authA, authB } = pair();
    const s = send(authA);
    delivery.inboxView(authB, 'cp-same', 10);
    delivery.inboxView(authB, 'cp-same', 10);
    const n = (db.prepare('SELECT COUNT(*) n FROM context_injections WHERE message_id=?').get(s.messageId) as { n: number }).n;
    expect(n).toBe(1);
  });

  it('6: same-epoch re-view still suppresses the body (no duplicate within an epoch)', () => {
    const { authA, authB } = pair();
    send(authA);
    delivery.inboxView(authB, 'cp1', 10);
    const again = delivery.inboxView({ ...authB }, 'cp2', 10); // same epoch
    expect(again[0]!.bodyIncluded).toBe(false);
  });

  it('8: explicit redelivery re-includes the body under a NEW logical injection number + warns', () => {
    const { authA, authB } = pair();
    const s = send(authA);
    delivery.inboxView(authB, 'cp1', 10);
    const re = delivery.redeliver(authB, s.messageId, 'operator asked to re-show');
    expect(re).not.toBeNull();
    expect(re!.bodyIncluded).toBe(true);
    expect(re!.text).toBe(BODY);
    const logicals = (db.prepare('SELECT logical_injection_number FROM context_injections WHERE message_id=? ORDER BY logical_injection_number').all(s.messageId) as Array<{ logical_injection_number: number }>).map((r) => r.logical_injection_number);
    expect(logicals).toEqual([1, 2]); // history preserved, new logical number
    const audit = db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='EXPLICIT_REDELIVERY' AND message_id=?").get(s.messageId) as { n: number };
    expect(audit.n).toBe(1); // audited
  });

  it('10: a reply after recovery is correlated to the ORIGINAL request', () => {
    const { authA, authB } = pair();
    const s = send(authA);
    const v = delivery.inboxView(authB, 'cp1', 10);
    const injectionId = v[0]!.injectionId!;
    delivery.ack(authB, { messageId: s.messageId, status: 'accepted', injectionId });
    const allocSeq = (rs: string) => {
      const row = db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(rs) as { next_sequence: number } | undefined;
      const seq = row ? row.next_sequence : 1;
      db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, ?)').run(rs, seq + 1);
      return seq;
    };
    const reply = delivery.reply(authB, { messageId: s.messageId, text: 'done', outcome: 'completed', injectionId }, allocSeq);
    expect(reply.correlationId).toBe(s.correlationId);
    const replyMsg = db.prepare("SELECT causation_id FROM messages WHERE kind='reply'").get() as { causation_id: string };
    expect(replyMsg.causation_id).toBe(s.messageId);
  });

  it('once accepted, the message no longer appears as injected-unacked', () => {
    const { authA, authB } = pair();
    const s = send(authA);
    const v = delivery.inboxView(authB, 'cp1', 10);
    delivery.ack(authB, { messageId: s.messageId, status: 'accepted', injectionId: v[0]!.injectionId! });
    const after = delivery.inboxView(authB, 'cp2', 10);
    expect(after).toHaveLength(0); // accepted -> not re-surfaced
  });

  it('F-redeliver: redelivery of a NEVER-injected (still-queued) message is REFUSED (no unannounced second body)', () => {
    const { authA, authB } = pair();
    const s = send(authA);
    // Message is queued but never injected for this epoch.
    const re = delivery.redeliver(authB, s.messageId, 'operator tries to redeliver a queued msg');
    expect(re).toBeNull(); // refused
    // No injection row was minted by the bogus redelivery...
    const inj = (db.prepare('SELECT COUNT(*) n FROM context_injections WHERE message_id=?').get(s.messageId) as { n: number }).n;
    expect(inj).toBe(0);
    // ...and a refusal is audited (not an EXPLICIT_REDELIVERY).
    const refused = (db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='REDELIVERY_REFUSED_NOT_INJECTED' AND message_id=?").get(s.messageId) as { n: number }).n;
    expect(refused).toBe(1);
    // The normal first presentation still works and shows the body exactly once.
    const v = delivery.inboxView(authB, 'cp1', 10);
    expect(v[0]!.bodyIncluded).toBe(true);
    const inj2 = (db.prepare('SELECT COUNT(*) n FROM context_injections WHERE message_id=?').get(s.messageId) as { n: number }).n;
    expect(inj2).toBe(1); // exactly one injection
  });

  it('3: a FRESH (never-injected) entry does not offer request-explicit-redelivery', () => {
    const { authA, authB } = pair();
    send(authA);
    const v1 = delivery.inboxView(authB, 'cp1', 10);
    // First presentation already includes the body; redelivery is meaningless here.
    expect(v1[0]!.allowedActions).not.toContain('request-explicit-redelivery');
    // ...but the recovery (already-presented) view DOES offer it.
    const v2 = delivery.inboxView(authB, 'cp2', 10);
    expect(v2[0]!.allowedActions).toContain('request-explicit-redelivery');
  });

  it('4: a REJECTED message is not resurfaced as injected-unacked', () => {
    const { authA, authB } = pair();
    const s = send(authA);
    const v = delivery.inboxView(authB, 'cp1', 10);
    delivery.ack(authB, { messageId: s.messageId, status: 'rejected', injectionId: v[0]!.injectionId! });
    const after = delivery.inboxView(authB, 'cp2', 10);
    expect(after).toHaveLength(0); // rejected is terminal -> not re-surfaced
  });

  it('7: redeliver of a message addressed to ANOTHER session returns null (authority)', () => {
    const { authA, authB } = pair();
    const s = send(authA); // addressed to B (implementer)
    delivery.inboxView(authB, 'cp1', 10);
    // A is the SENDER, not the recipient; A cannot force a redelivery to B.
    const re = delivery.redeliver(authA, s.messageId, 'sender tries to redeliver');
    expect(re).toBeNull();
    const audit = db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='EXPLICIT_REDELIVERY'").get() as { n: number };
    expect(audit.n).toBe(0); // no audit event for a rejected (null) redelivery
  });

  it('9: a normal inbox read NEVER triggers redelivery — body stays suppressed and no EXPLICIT_REDELIVERY is audited', () => {
    const { authA, authB } = pair();
    const s = send(authA);
    delivery.inboxView(authB, 'cp1', 10); // first presentation
    // Hammer the normal recovery path many times.
    for (let i = 0; i < 5; i++) {
      const v = delivery.inboxView(authB, `cp-recover-${i}`, 10);
      expect(v[0]!.bodyIncluded).toBe(false); // body NEVER auto-repeated
    }
    const inj = (db.prepare('SELECT COUNT(*) n FROM context_injections WHERE message_id=?').get(s.messageId) as { n: number }).n;
    expect(inj).toBe(1); // exactly one injection — no auto re-inject
    const audit = (db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type='EXPLICIT_REDELIVERY'").get() as { n: number }).n;
    expect(audit).toBe(0); // redelivery is NEVER automatic
  });
});
