/**
 * Dead-letter inspection/redrive (§9) + cancellation-by-state (§10).
 * Real SQLite, deterministic fake clock. Drives delivery state directly to focus
 * on the dead-letter / cancellation logic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore } from '../../src/broker/store.js';
import { DeadLetterStore } from '../../src/broker/deadletter.js';
import { CancellationOps } from '../../src/broker/cancellation.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { DeliveryState } from '../../src/protocol/states.js';

let dir: string;
let db: SqliteDriver;
let store: BrokerStore;
let dlq: DeadLetterStore;
let cancel: CancellationOps;
let clock: FakeClock;

const A = 'aaaa0000-0000-4000-8000-00000000000a';
const B = 'bbbb0000-0000-4000-8000-00000000000b';

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-dlq-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('d');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'broker-dlq');
  dlq = new DeadLetterStore(db, clock, ids);
  cancel = new CancellationOps(db, clock, ids);
}

function pair() {
  const authA = store.register({ sessionId: A, instanceId: 'iA', connectionId: 'cA', processId: 1, projectId: 'pa', cwd: '/a', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' });
  store.registerAlias(authA, 'architect');
  const authB = store.register({ sessionId: B, instanceId: 'iB', connectionId: 'cB', processId: 2, projectId: 'pb', cwd: '/b', receiveMode: 'hook_checkpoint', capabilities: [], role: 'hook' });
  store.registerAlias(authB, 'implementer');
  return { authA, authB };
}

beforeEach(setup);
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('dead-letter inspection + safe redrive (§9)', () => {
  it('lists + inspects with safe metadata and a recommended recovery', () => {
    const { authA } = pair();
    const s = store.send(authA, { to: 'implementer', text: 'x', kind: 'request', requiresAck: true, requiresReply: false });
    db.prepare(`UPDATE deliveries SET state='${DeliveryState.DEAD_LETTER}', failure_category='max_attempts', attempt_transport=6 WHERE message_id=?`).run(s.messageId);
    const list = dlq.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.messageId).toBe(s.messageId);
    expect(list[0]!.failureCategory).toBe('max_attempts');
    expect(list[0]!.attempts.transport).toBe(6);
    expect(list[0]!.recommendedRecovery).toMatch(/retry/i);
    expect(dlq.inspect(s.messageId)?.sender).toBe('architect');
  });

  it('redrive revalidates, allocates a NEW delivery id, and is explicit', () => {
    const { authA } = pair();
    const s = store.send(authA, { to: 'implementer', text: 'x', kind: 'request', requiresAck: true, requiresReply: false });
    const oldDelivery = (db.prepare('SELECT delivery_id FROM deliveries WHERE message_id=?').get(s.messageId) as { delivery_id: string }).delivery_id;
    db.prepare(`UPDATE deliveries SET state='${DeliveryState.DEAD_LETTER}', failure_category='max_attempts' WHERE message_id=?`).run(s.messageId);
    const r = dlq.redrive(s.messageId, () => ({ ok: true }));
    expect(r.ok).toBe(true);
    expect(r.newDeliveryId).toBeTruthy();
    expect(r.newDeliveryId).not.toBe(oldDelivery);
    const state = (db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(s.messageId) as { state: string }).state;
    expect(state).toBe(DeliveryState.QUEUED);
  });

  it('redrive WARNS when the message was previously context-injected (ambiguous)', () => {
    const { authA, authB } = pair();
    const s = store.send(authA, { to: 'implementer', text: 'x', kind: 'request', requiresAck: true, requiresReply: false });
    // record a context injection, then dead-letter it
    db.prepare('INSERT INTO context_injections (injection_id, message_id, recipient_session_id, recipient_epoch, checkpoint_id, injected_by_component_id, receipt_capability_hash, injected_at, expires_at, logical_injection_number) VALUES (?,?,?,?,?,?,?,?,?,1)').run('inj1', s.messageId, B, authB.epoch, 'cp1', 'c', 'h', clock.nowIso(), clock.nowIso());
    db.prepare(`UPDATE deliveries SET state='${DeliveryState.DEAD_LETTER}' WHERE message_id=?`).run(s.messageId);
    const r = dlq.redrive(s.messageId, () => ({ ok: true }));
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/duplicate/i);
  });

  it('redrive refuses when revalidation fails (e.g. now-blocked sender)', () => {
    const { authA } = pair();
    const s = store.send(authA, { to: 'implementer', text: 'x', kind: 'request', requiresAck: true, requiresReply: false });
    db.prepare(`UPDATE deliveries SET state='${DeliveryState.DEAD_LETTER}' WHERE message_id=?`).run(s.messageId);
    const r = dlq.redrive(s.messageId, () => ({ ok: false, reason: 'sender now blocked' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked/);
  });

  it('F-M3: redrive RESETS the new delivery attempt counters but PRESERVES prior history in the audit', () => {
    const { authA } = pair();
    const s = store.send(authA, { to: 'implementer', text: 'x', kind: 'request', requiresAck: true, requiresReply: false });
    // Dead-lettered via ack-timeout exhaustion: counters are saturated.
    db.prepare(`UPDATE deliveries SET state='${DeliveryState.DEAD_LETTER}', failure_category='ack_timeout_exhausted', attempt_ack_timeout=6, attempt_transport=2 WHERE message_id=?`).run(s.messageId);
    const r = dlq.redrive(s.messageId, () => ({ ok: true }));
    expect(r.ok).toBe(true);
    // New delivery attempt: its OWN counters reset to 0 (so it can survive a timeout).
    const d = db.prepare('SELECT attempt, attempt_ack_timeout, attempt_transport, attempt_injection, attempt_reply, state, next_attempt_at, lease_expires_at FROM deliveries WHERE message_id=?').get(s.messageId) as Record<string, unknown>;
    expect(d.state).toBe(DeliveryState.QUEUED);
    expect(d.attempt_ack_timeout).toBe(0);
    expect(d.attempt_transport).toBe(0);
    expect(d.attempt_injection).toBe(0);
    expect(d.attempt_reply).toBe(0);
    expect(d.next_attempt_at).toBeNull(); // immediately eligible
    expect(d.lease_expires_at).toBeNull();
    // History is NOT erased: the redrive audit records the prior counters.
    const audit = db.prepare("SELECT safe_metadata_json FROM audit_events WHERE event_type='DEAD_LETTER_REDRIVE' AND message_id=?").get(s.messageId) as { safe_metadata_json: string };
    const meta = JSON.parse(audit.safe_metadata_json);
    expect(meta.priorAttempts.ackTimeout).toBe(6);
    expect(meta.priorAttempts.transport).toBe(2);
    expect(meta.priorFailureCategory).toBe('ack_timeout_exhausted');
    expect(meta.priorDeliveryId).toBeTruthy();
  });

  it('discard moves it out of dead_letter terminally', () => {
    const { authA } = pair();
    const s = store.send(authA, { to: 'implementer', text: 'x', kind: 'request', requiresAck: true, requiresReply: false });
    db.prepare(`UPDATE deliveries SET state='${DeliveryState.DEAD_LETTER}' WHERE message_id=?`).run(s.messageId);
    expect(dlq.discard(s.messageId)).toBe(true);
    expect(dlq.inspect(s.messageId)).toBeNull();
  });
});

describe('cancellation semantics by state (§10)', () => {
  function sendQueued() {
    const { authA } = pair();
    const s = store.send(authA, { to: 'implementer', text: 'x', kind: 'request', requiresAck: true, requiresReply: false });
    return s.messageId;
  }

  it('queued -> cancelled_before_delivery (hard cancel)', () => {
    const mid = sendQueued();
    const r = cancel.cancel(mid);
    expect(r.outcome).toBe('cancelled_before_delivery');
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(mid) as { state: string }).state).toBe(DeliveryState.CANCELLED);
  });

  it('transport_written -> cancellation_requested_after_injection (advisory only)', () => {
    const mid = sendQueued();
    db.prepare(`UPDATE deliveries SET state='${DeliveryState.TRANSPORT_WRITTEN}' WHERE message_id=?`).run(mid);
    const r = cancel.cancel(mid);
    expect(r.outcome).toBe('cancellation_requested_after_injection');
    // NOT forced to cancelled — the model may already be acting
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(mid) as { state: string }).state).toBe(DeliveryState.TRANSPORT_WRITTEN);
  });

  it('completed -> already_completed', () => {
    const mid = sendQueued();
    db.prepare(`UPDATE deliveries SET state='${DeliveryState.COMPLETED}' WHERE message_id=?`).run(mid);
    expect(cancel.cancel(mid).outcome).toBe('already_completed');
  });

  it('unknown -> cannot_confirm_delivery_state', () => {
    expect(cancel.cancel('no-such-message').outcome).toBe('cannot_confirm_delivery_state');
  });
});
