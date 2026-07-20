/**
 * BETA.10 WS3 (#1) — operatorRedeliver, with the user-mandated accepted-vs-transport distinction.
 *
 * The operator (local-operator, no live component) can re-drive a message TO a recipient session.
 * TWO distinct semantics MUST stay distinguishable:
 *   (a) ORDINARY REDELIVERY — work NOT yet accepted (delivery in transport_written / queued /
 *       retry_wait): re-arm for re-injection to the recipient. Audited OPERATOR_REDELIVERY.
 *   (b) EXPLICIT REPLAY of ALREADY-ACCEPTED work (delivery state = 'accepted'): this is
 *       destructive/duplicate model-visible work. It MUST NOT happen silently — it requires an
 *       explicit confirmReplayAccepted acknowledgement, creates a NEW auditable attempt identity,
 *       and is audited distinctly (OPERATOR_ACCEPTED_REPLAY), NOT as an ordinary redelivery.
 *
 * RED-first: operatorRedeliver does not exist yet. Store-layer + delivery harness.
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
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-oredeliver-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('m');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'b');
  delivery = new DeliveryOps(db, clock, ids, 5 * 60_000, undefined, { requireReceipt: true });
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function reg(over: Partial<Parameters<BrokerStore['register']>[0]> = {}): SessionAuthority {
  const s = over.sessionId ?? sid();
  const auth = store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...over });
  store.signalReadiness(auth, { ackAvailable: true, versionOk: true });
  return auth;
}
function hookAuth(a: SessionAuthority): SessionAuthority { return { ...a, role: 'hook' as never }; }
function deliveryRow(messageId: string): { state: string; failure_category: string | null } {
  return db.prepare('SELECT state, failure_category FROM deliveries WHERE message_id=?').get(messageId) as { state: string; failure_category: string | null };
}
function auditCount(messageId: string, type: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM audit_events WHERE message_id=? AND event_type=?').get(messageId, type) as { n: number }).n;
}
/** Drive a message to transport_written (injected, not acked). */
function sendInject(sender: SessionAuthority, recipient: SessionAuthority, toAlias: string, text: string): string {
  const messageId = store.send(sender, { to: toAlias, text, kind: 'request', requiresAck: true, requiresReply: true }).messageId;
  delivery.checkpointPull(hookAuth(recipient), `cp-${messageId}`, 10);
  expect(deliveryRow(messageId).state).toBe('transport_written');
  return messageId;
}

describe('operatorRedeliver — ordinary redelivery (work NOT yet accepted)', () => {
  it('re-arms a transport_written delivery for re-injection; audits OPERATOR_REDELIVERY (not a replay)', () => {
    const r = reg({ requestedSessionName: 'worker' });
    const sender = reg({ requestedSessionName: 'ops' });
    const messageId = sendInject(sender, r, 'worker', 'do-it');
    // operator redelivers the not-yet-accepted work — ordinary path, no confirm needed.
    const out = store.operatorRedeliver(messageId, { reason: 'nudge' });
    expect(out.outcome).toBe('redelivered');
    expect(out.replay).toBe(false);
    // re-armed for re-injection (queued/retry_wait/transport_written — re-deliverable), not accepted.
    expect(['queued', 'retry_wait', 'transport_written']).toContain(deliveryRow(messageId).state);
    expect(auditCount(messageId, 'OPERATOR_REDELIVERY')).toBe(1);
    expect(auditCount(messageId, 'OPERATOR_ACCEPTED_REPLAY')).toBe(0); // NOT a replay
  });
});

describe('operatorRedeliver — explicit replay of ALREADY-ACCEPTED work', () => {
  function acceptedMessage(): { messageId: string; recipient: SessionAuthority } {
    const recipient = reg({ requestedSessionName: 'acc-worker' });
    const sender = reg({ requestedSessionName: 'acc-ops' });
    const messageId = sendInject(sender, recipient, 'acc-worker', 'accepted-work');
    const acked = delivery.ack(recipient, { messageId, status: 'accepted' });
    expect(acked.state).toBe('accepted');
    return { messageId, recipient };
  }

  it('REFUSES to replay accepted work WITHOUT the explicit confirmReplayAccepted acknowledgement', () => {
    const { messageId } = acceptedMessage();
    // No silent re-injection of accepted work: an unconfirmed operator redeliver of an ACCEPTED
    // delivery must be refused (it is destructive/duplicate model-visible work).
    expect(() => store.operatorRedeliver(messageId, { reason: 'oops' })).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/CONFIRMATION|ILLEGAL_STATE|DUPLICATE/) }),
    );
    // The accepted delivery is untouched; no replay audit; no ordinary-redelivery audit.
    expect(deliveryRow(messageId).state).toBe('accepted');
    expect(auditCount(messageId, 'OPERATOR_ACCEPTED_REPLAY')).toBe(0);
    expect(auditCount(messageId, 'OPERATOR_REDELIVERY')).toBe(0);
  });

  it('WITH confirmReplayAccepted: creates a NEW auditable attempt identity, distinct from ordinary redelivery', () => {
    const { messageId } = acceptedMessage();
    const out = store.operatorRedeliver(messageId, { reason: 'genuinely re-run this', confirmReplayAccepted: true });
    expect(out.outcome).toBe('replayed');
    expect(out.replay).toBe(true);
    // a NEW attempt identity is minted + returned (distinguishable, auditable)
    expect(typeof out.attemptId, 'replay mints a new attempt identity').toBe('string');
    expect(out.attemptId!.length).toBeGreaterThan(0);
    // audited DISTINCTLY as an accepted-replay, NOT as an ordinary redelivery
    expect(auditCount(messageId, 'OPERATOR_ACCEPTED_REPLAY')).toBe(1);
    expect(auditCount(messageId, 'OPERATOR_REDELIVERY')).toBe(0);
    // the replay attempt is recorded against the message (a new, distinguishable attempt),
    // and the original accepted delivery's history is preserved (not silently overwritten).
    const attemptRows = (db.prepare(`SELECT COUNT(*) n FROM audit_events WHERE message_id=? AND event_type='OPERATOR_ACCEPTED_REPLAY' AND safe_metadata_json LIKE ?`).get(messageId, `%${out.attemptId}%`) as { n: number }).n;
    expect(attemptRows, 'the new attempt id is recorded in the replay audit').toBe(1);
  });

  it('a non-existent message is refused cleanly (no throw-crash, explicit not-found)', () => {
    const out = store.operatorRedeliver('nope-0000-4000-8000-000000000000', { reason: 'x' });
    expect(out.outcome).toBe('not_found');
  });
});
