/**
 * Regression: the hook (ephemeral, injects) and the MCP server (long-lived,
 * acks/replies) are the SAME session but register/pull independently, often
 * with different generations within one session lifetime. This reproduces the
 * live-test bug where:
 *  - a hook injects under generation G,
 *  - the MCP server then re-registers (generation G+1),
 *  - and the ack/reply must STILL succeed (and not be clobbered by
 *    reconnect-recovery re-queuing the fresh injection).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { systemClock, uuidIdGen } from '../../src/shared/clock.js';
import { DeliveryState } from '../../src/protocol/states.js';

let dir: string;
let db: SqliteDriver;
let store: BrokerStore;
let delivery: DeliveryOps;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-coord-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  runMigrations(db, systemClock.nowIso());
  store = new BrokerStore(db, systemClock, uuidIdGen, 'broker-coord');
  delivery = new DeliveryOps(db, systemClock, uuidIdGen);
});

afterEach(() => {
  db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Simulate a connection drop for a session (what daemon.onConnClose does):
 *  clears the live binding AND closes the live component rows, so the next
 *  register is a clean reconnect (not blocked by the split-brain guard). */
function disconnect(sessionId: string): void {
  db.prepare(`UPDATE sessions SET state='disconnected', bound_connection_id=NULL WHERE session_id=?`).run(sessionId);
  db.prepare(`UPDATE component_instances SET state='closed' WHERE session_id=? AND state='live'`).run(sessionId);
}

function allocSeq(recipientSessionId: string): number {
  const row = db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(recipientSessionId) as { next_sequence: number } | undefined;
  const seq = row ? row.next_sequence : 1;
  db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, ?)').run(recipientSessionId, seq + 1);
  return seq;
}

describe('hook/MCP-server generation coordination', () => {
  it('ack+reply succeed after the MCP server re-registers post hook injection', () => {
    const sidA = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const sidB = 'bbbbbbbb-0000-4000-8000-00000000000b';
    // A and B both register once.
    const authA = store.register({ sessionId: sidA, instanceId: 'iA1', connectionId: 'cA1', processId: 1, projectId: 'pA', cwd: '/a', receiveMode: 'hook_checkpoint', capabilities: [] });
    store.register({ sessionId: sidB, instanceId: 'iB1', connectionId: 'cB1', processId: 2, projectId: 'pB', cwd: '/b', receiveMode: 'hook_checkpoint', capabilities: [] });
    store.registerAlias(authA, 'architect');
    disconnect(sidB); // B's first registering connection exits before re-registering
    const authB1 = store.register({ sessionId: sidB, instanceId: 'iB1b', connectionId: 'cB1b', processId: 2, projectId: 'pB', cwd: '/b', receiveMode: 'hook_checkpoint', capabilities: [] });
    store.registerAlias(authB1, 'implementer');

    // A sends to B.
    const send = store.send(authA, { to: 'implementer', text: 'ping', kind: 'request', requiresAck: true, requiresReply: true });
    expect(send.state).toBe(DeliveryState.QUEUED);

    // B's hook injects (ephemeral pull by sessionId, under B's current generation).
    const injected = delivery.checkpointPullBySessionId(sidB, 10);
    expect(injected).toHaveLength(1);
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(send.messageId) as { state: string }).state).toBe(DeliveryState.TRANSPORT_WRITTEN);

    // NOW the MCP server (same session) re-registers. Under ADR 0003 this is a
    // COMPONENT reconnect that JOINS the current epoch — it must NOT advance the
    // epoch (that was the old-model bug). Same epoch, new component instance.
    disconnect(sidB);
    const authB2 = store.register({ sessionId: sidB, instanceId: 'iB2', connectionId: 'cB2', processId: 2, projectId: 'pB', cwd: '/b', receiveMode: 'hook_checkpoint', capabilities: [] });
    expect(authB2.epoch).toBe(authB1.epoch); // epoch unchanged on component reconnect
    expect(authB2.componentInstanceId).not.toBe(authB1.componentInstanceId); // distinct component

    // The fresh injection must NOT have been clobbered back to queued.
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(send.messageId) as { state: string }).state).toBe(DeliveryState.TRANSPORT_WRITTEN);

    // The model (via the MCP server, current generation authB2) acks then replies.
    const ack = delivery.ack(authB2, { messageId: send.messageId, status: 'accepted' });
    expect(ack.state).toBe(DeliveryState.ACCEPTED);
    const reply = delivery.reply(authB2, { messageId: send.messageId, text: 'pong v1', outcome: 'completed' }, allocSeq);
    expect(reply.replyMessageId).toBeTruthy();

    // Original delivery is COMPLETED (not stuck in transport_written).
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(send.messageId) as { state: string }).state).toBe(DeliveryState.COMPLETED);

    // A second (Stop) hook pull finds NOTHING to re-inject (no duplicate).
    const second = delivery.checkpointPullBySessionId(sidB, 10);
    expect(second).toHaveLength(0);
  });

  it('genuinely abandoned injection (expired lease) IS re-queued on reconnect', () => {
    // Use a short ack deadline so the lease expires quickly.
    const fastDelivery = new DeliveryOps(db, systemClock, uuidIdGen, 1); // 1ms deadline
    const sidA = 'cccccccc-0000-4000-8000-00000000000c';
    const sidB = 'dddddddd-0000-4000-8000-00000000000d';
    const authA = store.register({ sessionId: sidA, instanceId: 'iA', connectionId: 'cA', processId: 1, projectId: 'pA', cwd: '/a', receiveMode: 'hook_checkpoint', capabilities: [] });
    store.register({ sessionId: sidB, instanceId: 'iB', connectionId: 'cB', processId: 2, projectId: 'pB', cwd: '/b', receiveMode: 'hook_checkpoint', capabilities: [] });
    store.registerAlias(authA, 'architect');
    disconnect(sidB);
    const authB = store.register({ sessionId: sidB, instanceId: 'iB2', connectionId: 'cB2', processId: 2, projectId: 'pB', cwd: '/b', receiveMode: 'hook_checkpoint', capabilities: [] });
    store.registerAlias(authB, 'implementer');
    const send = store.send(authA, { to: 'implementer', text: 'ping', kind: 'request', requiresAck: true, requiresReply: false });
    fastDelivery.markInjectedFor(authB, [send.messageId]); // lease = now+1ms
    // Wait for the lease to lapse, then reconnect -> recovery re-queues it.
    const until = Date.now() + 10;
    while (Date.now() < until) { /* spin briefly */ }
    disconnect(sidB);
    store.register({ sessionId: sidB, instanceId: 'iB3', connectionId: 'cB3', processId: 2, projectId: 'pB', cwd: '/b', receiveMode: 'hook_checkpoint', capabilities: [] });
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(send.messageId) as { state: string }).state).toBe(DeliveryState.QUEUED);
  });
});
