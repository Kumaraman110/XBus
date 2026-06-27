/**
 * Injection ledger uniqueness (reliability contract §6): at-most-once context
 * injection per (message_id, recipient_epoch). Exercises the crash-window
 * outcomes deterministically against the real schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { ReceiptStore } from '../../src/broker/receipts.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string;
let db: SqliteDriver;
let receipts: ReceiptStore;
let clock: FakeClock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-ledger-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  receipts = new ReceiptStore(db, clock, new SeqIdGen('inj'));
  // a message row is required by the FK
  db.exec(`INSERT INTO sessions (session_id, automatic_alias, generation, high_water_generation, active_epoch, project_id, cwd, xbus_version, capabilities_json, receive_mode, state, last_seen_at, created_at, updated_at) VALUES ('S','session-s',1,1,1,'p','/','0','[]','hook_checkpoint','connected','t','t','t')`);
  db.exec(`INSERT INTO recipient_sequences VALUES ('S',2)`);
  db.exec(`INSERT INTO messages (message_id, protocol_version, sender_session_id, sender_alias, recipient_session_id, recipient_alias, kind, correlation_id, recipient_sequence, body_text, body_hash, requires_ack, requires_reply, created_at, trace_id) VALUES ('M',1,'S','a','S','b','request','M',1,'hi','h',1,0,'t','tr')`);
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function inject(checkpointId: string, epoch = 1) {
  return receipts.issue({ messageId: 'M', recipientSessionId: 'S', recipientEpoch: epoch, checkpointId, componentId: 'hook-1' });
}

describe('injection ledger — at-most-once per (message, epoch)', () => {
  it('first injection succeeds; a SECOND for the same epoch is blocked (returns null)', () => {
    expect(inject('cp1')).not.toBeNull();
    // window #9: same checkpoint fires twice
    expect(inject('cp1')).toBeNull();
    // a DIFFERENT checkpoint, same epoch -> still blocked (at-most-once per epoch)
    expect(inject('cp2')).toBeNull();
    const rows = db.prepare('SELECT COUNT(*) n FROM context_injections WHERE message_id=? AND recipient_epoch=1').get('M') as { n: number };
    expect(rows.n).toBe(1); // exactly one effective injection in epoch 1
  });

  it('a NEW epoch (window #7: resume/takeover) gets its own injection slot', () => {
    expect(inject('cp1', 1)).not.toBeNull();
    expect(inject('cp2', 2)).not.toBeNull(); // epoch 2 is a different ledger key (distinct checkpoint)
    const rows = db.prepare('SELECT recipient_epoch FROM context_injections WHERE message_id=? ORDER BY recipient_epoch').all('M') as Array<{ recipient_epoch: number }>;
    expect(rows.map((r) => r.recipient_epoch)).toEqual([1, 2]);
  });

  it('the unique index ux_injection_logical enforces it at the DB level', () => {
    inject('cp1', 1);
    // direct duplicate insert with the same (message, epoch, logical#) must throw
    expect(() => db.prepare(
      'INSERT INTO context_injections (injection_id, message_id, recipient_session_id, recipient_epoch, checkpoint_id, injected_by_component_id, receipt_capability_hash, injected_at, expires_at, logical_injection_number) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run('dup', 'M', 'S', 1, 'cpX', 'c', 'hash', 't', 't', 1)).toThrow();
  });

  it('an explicit redelivery (logical_injection_number=2) is allowed — the only re-inject path', () => {
    expect(inject('cp1', 1)).not.toBeNull();
    const redelivery = receipts.issue({ messageId: 'M', recipientSessionId: 'S', recipientEpoch: 1, checkpointId: 'cp-redrive', componentId: 'hook-1', logicalInjectionNumber: 2 });
    expect(redelivery).not.toBeNull(); // explicit policy bump, not silent
  });

  it('authorize() ties an ack to the injection by connection identity, one-time per op', () => {
    const inj = inject('cp1', 1)!;
    // ack authorized once
    const v = receipts.authorize('ack', { messageId: 'M', sessionId: 'S', epoch: 1, injectionId: inj.injectionId });
    expect(v.injectionId).toBe(inj.injectionId);
    receipts.consume(inj.injectionId, 'ack');
    // replay for the same op -> rejected
    expect(() => receipts.authorize('ack', { messageId: 'M', sessionId: 'S', epoch: 1, injectionId: inj.injectionId })).toThrow(/already used/i);
    // a reply (distinct op) is still allowed once
    expect(receipts.authorize('reply', { messageId: 'M', sessionId: 'S', epoch: 1, injectionId: inj.injectionId }).injectionId).toBe(inj.injectionId);
  });
});
