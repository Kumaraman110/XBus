/**
 * People-facing scheduling states (ADR 0009), enforced BEFORE the retry engine.
 * paused / do_not_disturb / manual_checkpoint suppress automatic delivery;
 * blocked sender is rejected before persistence. Direct store/delivery against
 * real node:sqlite (deterministic, fake clock).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { ControlsStore } from '../../src/broker/controls.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { DeliveryState } from '../../src/protocol/states.js';
import { isXBusError } from '../../src/protocol/errors.js';

let dir: string;
let db: SqliteDriver;
let clock: FakeClock;
let store: BrokerStore;
let delivery: DeliveryOps;
let controls: ControlsStore;

const A = 'aaaa0000-0000-4000-8000-00000000000a';
const B = 'bbbb0000-0000-4000-8000-00000000000b';

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-sched-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('s');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'broker-sched');
  delivery = new DeliveryOps(db, clock, ids);
  controls = new ControlsStore(db, clock);
}

function registerPair() {
  const authA = store.register({ sessionId: A, instanceId: 'iA', connectionId: 'cA', processId: 1, projectId: 'pa', cwd: '/a', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' });
  store.registerAlias(authA, 'architect');
  const authB = store.register({ sessionId: B, instanceId: 'iB', connectionId: 'cB', processId: 2, projectId: 'pb', cwd: '/b', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'hook' });
  store.registerAlias(authB, 'implementer');
  // §2: B must be ready to accept injection (these tests exercise the scheduling
  // controls, which are downstream of the readiness gate).
  store.signalReadiness(authB, { ackAvailable: true, versionOk: true });
  return { authA, authB };
}

beforeEach(setup);
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('scheduling states (enforced before delivery)', () => {
  it('paused: message persists, automatic checkpoint pull returns nothing, no attempt consumed', () => {
    const { authA, authB } = registerPair();
    store.send(authA, { to: 'implementer', text: 'x', kind: 'request', requiresAck: true, requiresReply: false });
    controls.setControl(B, 'paused');
    const pulled = delivery.checkpointPull(authB, 'cp1', 10);
    expect(pulled).toHaveLength(0); // suppressed
    // message is still queued (persisted), attempt unchanged
    const d = db.prepare("SELECT state, attempt FROM deliveries WHERE recipient_session_id=?").get(B) as { state: string; attempt: number };
    expect(d.state).toBe(DeliveryState.QUEUED);
    expect(d.attempt).toBe(0);
    // resume -> eligible again
    controls.setControl(B, 'active');
    expect(delivery.checkpointPull(authB, 'cp2', 10)).toHaveLength(1);
  });

  it('do_not_disturb: automatic delivery suppressed; inspectable via peek (pendingForSession)', () => {
    const { authA, authB } = registerPair();
    store.send(authA, { to: 'implementer', text: 'x', kind: 'request', requiresAck: true, requiresReply: false });
    controls.setControl(B, 'do_not_disturb');
    expect(delivery.checkpointPull(authB, 'cp1', 10)).toHaveLength(0);
    // peek (does not inject) still shows it
    expect(delivery.pendingForSession(authB, {})).toHaveLength(1);
  });

  it('manual_checkpoint: auto pull suppressed; process-next injects exactly one', () => {
    const { authA, authB } = registerPair();
    store.send(authA, { to: 'implementer', text: 'm1', kind: 'request', requiresAck: true, requiresReply: false });
    store.send(authA, { to: 'implementer', text: 'm2', kind: 'event', requiresAck: false, requiresReply: false });
    controls.setControl(B, 'manual_checkpoint');
    expect(delivery.checkpointPull(authB, 'cp1', 10)).toHaveLength(0); // no auto
    const one = delivery.processNext(authB, 'cp-manual-1');
    expect(one).toHaveLength(1); // exactly one, explicit
    const two = delivery.processNext(authB, 'cp-manual-2');
    expect(two).toHaveLength(1); // the next one
  });

  it('blocked sender: send is rejected BEFORE persistence (no normal success)', () => {
    const { authA } = registerPair();
    controls.blockPeer(B, 'architect', () => new SeqIdGen('blk').next());
    const before = (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;
    try {
      store.send(authA, { to: 'implementer', text: 'blocked!', kind: 'request', requiresAck: true, requiresReply: false });
      throw new Error('expected XBUS_BLOCKED');
    } catch (e) {
      expect(isXBusError(e)).toBe(true);
      if (isXBusError(e)) expect(e.code).toBe('XBUS_BLOCKED');
    }
    const after = (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;
    expect(after).toBe(before); // nothing persisted
    // unblock -> send works
    controls.unblockPeer(B, 'architect');
    const r = store.send(authA, { to: 'implementer', text: 'ok now', kind: 'request', requiresAck: true, requiresReply: false });
    expect(r.messageId).toBeTruthy();
  });
});
