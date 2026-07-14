/**
 * Beta.6 Phase 2 (ADR 0017/0021): threaded messaging + the local-operator principal.
 *
 * Proves the broker-core contract WITHOUT the daemon/dashboard: an operator opens a
 * thread to a session, the session acks + replies, the operator follows up, and the
 * linkage (thread_id / correlation_id / parent_message_id / causation_id / thread_sequence)
 * is exactly correct across turns (ADR 0021 worked example). Also proves: operator
 * identity is the reserved 'local-operator' (never spoofable, never expiring, unmanaged),
 * idempotent operator send (no duplicate on retry), exactly-once visible injection is
 * unchanged, and per-participant unread is derived from committed rows.
 *
 * Red→green: written against the pre-beta.6 store these assertions fail (no operatorSend,
 * no thread columns, operator row absent). Driven with a FakeClock for determinism.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps, INJECTION_METADATA_KEY } from '../../src/broker/delivery.js';
import { ensureOperatorSession, OPERATOR_SESSION_ID, OPERATOR_ALIAS } from '../../src/broker/operator.js';
import { Reaper } from '../../src/broker/reaper.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let delivery: DeliveryOps; let clock: FakeClock; let ids: SeqIdGen;
const S = 'ssss6666-0000-4000-8000-00000000000c'; // a Claude session

function setup(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-thread-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  ids = new SeqIdGen('t');
  runMigrations(db, clock.nowIso());
  ensureOperatorSession(db, clock);
  store = new BrokerStore(db, clock, ids, 'b');
  delivery = new DeliveryOps(db, clock, ids, 5 * 60_000);
}
beforeEach(() => setup());
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function registerSession(): SessionAuthority {
  const auth = store.register({ sessionId: S, instanceId: 'iS', connectionId: 'cS', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'seatmap-api' });
  store.signalReadiness(auth, { ackAvailable: true, hookAvailable: true, versionOk: true });
  return auth;
}
function hookAuth(auth: SessionAuthority): SessionAuthority { return { ...auth, role: 'hook' as never }; }
function allocSeq(recipientSessionId: string): number {
  const row = db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(recipientSessionId) as { next_sequence: number } | undefined;
  const seq = row ? row.next_sequence : 1;
  db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, ?)').run(recipientSessionId, seq + 1);
  return seq;
}
function msgRow(messageId: string) {
  return db.prepare('SELECT thread_id, thread_sequence, correlation_id, causation_id, parent_message_id, author_type, sender_session_id, recipient_session_id FROM messages WHERE message_id=?').get(messageId) as { thread_id: string; thread_sequence: number; correlation_id: string; causation_id: string | null; parent_message_id: string | null; author_type: string; sender_session_id: string; recipient_session_id: string };
}
function injectionCount(messageId: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM context_injections WHERE message_id=?').get(messageId) as { n: number }).n;
}

describe('local-operator principal (ADR 0021)', () => {
  it('is provisioned as a reserved, unmanaged, non-routable, non-expiring session row', () => {
    const row = db.prepare('SELECT session_id, management_state, state, readiness, session_name, session_name_state, expires_at, expired_at, active_epoch FROM sessions WHERE session_id=?').get(OPERATOR_SESSION_ID) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.management_state).toBe('unmanaged');   // → deriveSessionLabel 'unmanaged'/not-routable
    expect(row.state).toBe('disconnected');
    expect(row.readiness).toBe('disconnected');
    expect(row.session_name).toBe(OPERATOR_ALIAS);
    expect(row.session_name_state).toBe('active');    // reserved name locked
    expect(row.expires_at).toBeNull();                 // never on the retention clock
    expect(row.expired_at).toBeNull();
    expect(row.active_epoch).toBe(0);                  // never registered a component
    // Has a recipient_sequences row so a reply can allocate against it (the FK requirement).
    const seq = db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(OPERATOR_SESSION_ID) as { next_sequence: number } | undefined;
    expect(seq?.next_sequence).toBe(1);
    // Has an active alias so from= shows 'local-operator', not a session-xxxx fallback.
    const alias = db.prepare(`SELECT alias FROM aliases WHERE session_id=? AND active=1`).get(OPERATOR_SESSION_ID) as { alias: string } | undefined;
    expect(alias?.alias).toBe(OPERATOR_ALIAS);
  });

  it('ensureOperatorSession is idempotent (a second call creates no duplicate)', () => {
    ensureOperatorSession(db, clock);
    ensureOperatorSession(db, clock);
    const n = (db.prepare('SELECT COUNT(*) n FROM sessions WHERE session_id=?').get(OPERATOR_SESSION_ID) as { n: number }).n;
    expect(n).toBe(1);
  });

  it('a peer CANNOT register as the reserved operator session id (no impersonation via register)', () => {
    // ADR 0021 hardening: store.register must refuse the reserved id (the daemon also gates it
    // pre-store). Registering it would bind a live component to the operator + make it routable.
    expect(() => store.register({ sessionId: OPERATOR_SESSION_ID, instanceId: 'x', connectionId: 'cx', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' })).toThrow();
    // The operator row is untouched: still unmanaged, no live component, epoch 0.
    const row = db.prepare('SELECT management_state, active_epoch FROM sessions WHERE session_id=?').get(OPERATOR_SESSION_ID) as { management_state: string; active_epoch: number };
    expect(row.management_state).toBe('unmanaged');
    expect(row.active_epoch).toBe(0);
    const live = db.prepare(`SELECT COUNT(*) n FROM component_instances WHERE session_id=? AND state='live'`).get(OPERATOR_SESSION_ID) as { n: number };
    expect(live.n).toBe(0);
  });

  it('ensureOperatorSession does not crash if a foreign session already holds the name/alias', () => {
    // A pre-reservation legacy DB could have a different session holding 'local-operator'.
    // Provisioning must NOT hit the active-name / active-alias unique indexes and crash.
    const other = 'ffff0000-0000-4000-8000-00000000000f';
    // Fresh DB (this test wants the operator NOT yet present) — rebuild a clean one.
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-opclash-'));
    const db2 = openDatabase(path.join(d2, 'x.sqlite'), { applyPragmas: true });
    try {
      runMigrations(db2, clock.nowIso());
      // A foreign session squats the reserved name + alias BEFORE the operator is provisioned.
      db2.prepare(`INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, state, last_seen_at, created_at, updated_at, session_name, normalized_session_name, session_name_state) VALUES (?,?,?,?,?,?, 'connected', ?,?,?, 'local-operator','local-operator','active')`).run(other, 'session-ffff0000', 'p', '/', '0', '[]', 'n', 'n', 'n');
      db2.prepare(`INSERT INTO aliases (alias_id, alias, alias_ci, scope, project_id, session_id, active, created_at) VALUES ('a-other','local-operator','local-operator','global',NULL,?,1,'n')`).run(other);
      // Must NOT throw, and must still create the operator row (addressable by its id).
      expect(() => ensureOperatorSession(db2, clock)).not.toThrow();
      const op = db2.prepare('SELECT session_id, management_state FROM sessions WHERE session_id=?').get(OPERATOR_SESSION_ID) as { session_id: string; management_state: string } | undefined;
      expect(op).toBeDefined();
      expect(op!.management_state).toBe('unmanaged');
      // The foreign session keeps its name (no clobber); the operator fell back to unnamed.
      const opName = db2.prepare('SELECT session_name_state FROM sessions WHERE session_id=?').get(OPERATOR_SESSION_ID) as { session_name_state: string };
      expect(opName.session_name_state).toBe('unnamed');
    } finally { db2.close(); try { fs.rmSync(d2, { recursive: true, force: true }); } catch { /* */ } }
  });

  it('the retention reaper NEVER expires the operator, even if expires_at were set', () => {
    // Force a due expiry on the operator, then sweep — it must survive.
    db.prepare('UPDATE sessions SET expires_at=? WHERE session_id=?').run('2000-01-01T00:00:00.000Z', OPERATOR_SESSION_ID);
    const reaper = new Reaper(db, clock, ids, { rng: () => 1 });
    reaper.sweep();
    const row = db.prepare('SELECT expired_at FROM sessions WHERE session_id=?').get(OPERATOR_SESSION_ID) as { expired_at: string | null };
    expect(row.expired_at).toBeNull();
  });
});

describe('operator ↔ session thread — linkage semantics (ADR 0021 worked example)', () => {
  it('opens a thread, session acks + replies, operator follows up — sequence/parent/correlation/causation exact', () => {
    const auth = registerSession();

    // Turn 1: operator OPENS a thread (no threadId).
    const t1 = store.operatorSend({ to: 'seatmap-api', text: 'please summarize the seatmap diff', kind: 'request', requiresAck: true, requiresReply: true, subject: 'seatmap review' });
    const T = t1.threadId;
    expect(t1.authorType).toBe('operator');
    expect(t1.threadSequence).toBe(1);
    const r1 = msgRow(t1.messageId);
    expect(r1.thread_id).toBe(T);
    expect(r1.correlation_id).toBe(T);        // root: correlation == thread id == messageId
    expect(T).toBe(t1.messageId);
    expect(r1.parent_message_id).toBeNull();
    expect(r1.causation_id).toBeNull();
    expect(r1.author_type).toBe('operator');
    expect(r1.sender_session_id).toBe(OPERATOR_SESSION_ID);
    expect(r1.recipient_session_id).toBe(S);

    // The session receives it at a checkpoint (sender-agnostic injection), acks, replies.
    const pulled = delivery.checkpointPull(hookAuth(auth), 'cp-1', 10);
    expect(pulled.map((m) => m.messageId)).toContain(t1.messageId);
    const injId = pulled.find((m) => m.messageId === t1.messageId)!.metadata![INJECTION_METADATA_KEY];
    expect(injId).toBeTruthy();
    expect(injectionCount(t1.messageId)).toBe(1); // exactly-once visible injection
    const ack = delivery.ack(auth, { messageId: t1.messageId, status: 'accepted', injectionId: injId });
    expect(ack.state).toBe('accepted');

    // Turn 2 (thread_sequence 2): session replies → routed back to the operator.
    const rep1 = delivery.reply(auth, { messageId: t1.messageId, text: 'diff adds 16 Polaris fields', outcome: 'completed', injectionId: injId }, allocSeq);
    const r2 = msgRow(rep1.replyMessageId);
    expect(r2.thread_id).toBe(T);
    expect(r2.thread_sequence).toBe(2);
    expect(r2.correlation_id).toBe(T);        // reply inherits the thread's correlation
    expect(r2.parent_message_id).toBe(t1.messageId);
    expect(r2.causation_id).toBe(t1.messageId);
    expect(r2.author_type).toBe('claude');
    expect(r2.sender_session_id).toBe(S);
    expect(r2.recipient_session_id).toBe(OPERATOR_SESSION_ID); // reply lands in the operator's queue
    // The reply-to-operator delivery exists and is queued (the operator does no pull, so it stays there).
    const repDelivery = db.prepare('SELECT recipient_session_id, state FROM deliveries WHERE message_id=?').get(rep1.replyMessageId) as { recipient_session_id: string; state: string };
    expect(repDelivery.recipient_session_id).toBe(OPERATOR_SESSION_ID);

    // Turn 3 (thread_sequence 3): operator follows up IN THE SAME THREAD.
    const t2 = store.operatorSend({ to: 'seatmap-api', text: 'which field is misspelled?', kind: 'request', requiresAck: true, requiresReply: true, threadId: T });
    const r3 = msgRow(t2.messageId);
    expect(t2.threadId).toBe(T);
    expect(r3.thread_sequence).toBe(3);
    expect(r3.correlation_id).toBe(T);
    expect(r3.parent_message_id).toBe(rep1.replyMessageId); // parent = the latest turn (the reply)
    expect(r3.causation_id).toBe(rep1.replyMessageId);
    expect(r3.author_type).toBe('operator');

    // Turn 4 (thread_sequence 4): session replies to the follow-up.
    const pulled2 = delivery.checkpointPull(hookAuth(auth), 'cp-2', 10);
    const injId2 = pulled2.find((m) => m.messageId === t2.messageId)!.metadata![INJECTION_METADATA_KEY];
    delivery.ack(auth, { messageId: t2.messageId, status: 'accepted', injectionId: injId2 });
    const rep2 = delivery.reply(auth, { messageId: t2.messageId, text: 'noComplementarySeatsAvailble (missing i)', outcome: 'completed', injectionId: injId2 }, allocSeq);
    const r4 = msgRow(rep2.replyMessageId);
    expect(r4.thread_sequence).toBe(4);
    expect(r4.parent_message_id).toBe(t2.messageId);

    // The thread's high-water sequence is 4; the whole thread shares correlation_id = T.
    const thread = db.prepare('SELECT last_thread_sequence FROM threads WHERE thread_id=?').get(T) as { last_thread_sequence: number };
    expect(thread.last_thread_sequence).toBe(4);
    const distinctCorr = db.prepare('SELECT COUNT(DISTINCT correlation_id) n FROM messages WHERE thread_id=?').get(T) as { n: number };
    expect(distinctCorr.n).toBe(1);
    const seqs = (db.prepare('SELECT thread_sequence FROM messages WHERE thread_id=? ORDER BY thread_sequence').all(T) as Array<{ thread_sequence: number }>).map((x) => x.thread_sequence);
    expect(seqs).toEqual([1, 2, 3, 4]); // monotonic, gap-free, single ordering across both directions
  });
});

describe('operator thread access control (ADR 0021 hardening)', () => {
  it('the operator CANNOT continue a thread it does not participate in (e.g. a backfilled peer thread)', () => {
    registerSession();
    // Simulate a peer-to-peer / backfilled thread with NO operator participant.
    const foreignThread = 'peer-thread-xyz';
    db.prepare(`INSERT INTO threads (thread_id, root_message_id, created_by_actor, state, created_at, updated_at, last_message_at) VALUES (?,?,?, 'open', ?,?,?)`).run(foreignThread, 'm-root', S, clock.nowIso(), clock.nowIso(), clock.nowIso());
    db.prepare(`INSERT INTO thread_participants (participant_id, thread_id, session_id, actor_kind, participant_role, joined_at) VALUES ('pp','${foreignThread}','${S}','claude','member',?)`).run(clock.nowIso());
    // A tab-token holder tries to inject an operator turn into it → rejected (not a participant).
    expect(() => store.operatorSend({ to: 'seatmap-api', text: 'sneak in', kind: 'request', requiresAck: false, requiresReply: false, threadId: foreignThread })).toThrow();
    // No operator turn was persisted into the foreign thread.
    const n = (db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=? AND sender_session_id=?').get(foreignThread, OPERATOR_SESSION_ID) as { n: number }).n;
    expect(n).toBe(0);
  });

  it('a follow-up recipient must match the thread\'s peer (no retargeting a thread to a third session)', () => {
    const auth = registerSession();
    // A second routable session C.
    const C = 'cccc6666-0000-4000-8000-00000000000e';
    const authC = store.register({ sessionId: C, instanceId: 'iC', connectionId: 'cC', processId: 3, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'other-svc' });
    store.signalReadiness(authC, { ackAvailable: true, versionOk: true });
    const t = store.operatorSend({ to: 'seatmap-api', text: 'q', kind: 'request', requiresAck: true, requiresReply: true });
    // Continuing the thread but addressing a DIFFERENT session → rejected.
    expect(() => store.operatorSend({ to: 'other-svc', text: 'redirect', kind: 'request', requiresAck: false, requiresReply: false, threadId: t.threadId })).toThrow();
    void auth; void authC;
  });

  it('sending a follow-up does NOT clear the unread badge for an intervening unread peer turn', () => {
    const auth = registerSession();
    const t = store.operatorSend({ to: 'seatmap-api', text: 'q1', kind: 'request', requiresAck: true, requiresReply: true });
    const T = t.threadId;
    // Peer replies (seq 2) — now the operator has 1 unread.
    const inj = delivery.checkpointPull(hookAuth(auth), 'cp', 10).find((m) => m.messageId === t.messageId)!.metadata![INJECTION_METADATA_KEY];
    delivery.ack(auth, { messageId: t.messageId, status: 'accepted', injectionId: inj });
    delivery.reply(auth, { messageId: t.messageId, text: 'a1', outcome: 'completed', injectionId: inj }, allocSeq);
    const unread = (): number => {
      const cur = db.prepare('SELECT last_read_thread_seq FROM thread_participants WHERE thread_id=? AND session_id=?').get(T, OPERATOR_SESSION_ID) as { last_read_thread_seq: number };
      return (db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=? AND thread_sequence > ? AND sender_session_id <> ?').get(T, cur.last_read_thread_seq, OPERATOR_SESSION_ID) as { n: number }).n;
    };
    expect(unread()).toBe(1);
    // Operator sends a follow-up (seq 3) WITHOUT opening the reply. The unread peer turn (seq 2)
    // must STILL count as unread — sending must not advance the read cursor past it.
    store.operatorSend({ to: 'seatmap-api', text: 'q2', kind: 'request', requiresAck: false, requiresReply: false, threadId: T });
    expect(unread()).toBe(1); // the intervening peer reply is still unread
  });
});

describe('operator send — idempotency + safe retry', () => {
  it('a retried operator send with the same idempotency key creates NO duplicate', () => {
    registerSession();
    const key = 'compose-abc-123';
    const first = store.operatorSend({ to: 'seatmap-api', text: 'hello', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    const second = store.operatorSend({ to: 'seatmap-api', text: 'hello', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    expect(second.deduplicated).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    const n = (db.prepare('SELECT COUNT(*) n FROM messages WHERE sender_session_id=? AND idempotency_key=?').get(OPERATOR_SESSION_ID, key) as { n: number }).n;
    expect(n).toBe(1);
    // Exactly one delivery + one thread turn.
    const d = (db.prepare('SELECT COUNT(*) n FROM deliveries WHERE message_id=?').get(first.messageId) as { n: number }).n;
    expect(d).toBe(1);
  });

  it('the operator cannot message itself, and cannot send to an unknown recipient', () => {
    registerSession();
    expect(() => store.operatorSend({ to: OPERATOR_ALIAS, text: 'x', kind: 'request', requiresAck: false, requiresReply: false })).toThrow();
    expect(() => store.operatorSend({ to: 'no-such-session', text: 'x', kind: 'request', requiresAck: false, requiresReply: false })).toThrow();
  });
});

describe('per-participant unread (ADR 0021 D6)', () => {
  it('a session turn is unread to the operator until mark-read advances the cursor', () => {
    const auth = registerSession();
    const t1 = store.operatorSend({ to: 'seatmap-api', text: 'q', kind: 'request', requiresAck: true, requiresReply: true });
    const T = t1.threadId;
    // Operator has read its own turn (seq 1) — unread for the operator is 0 so far.
    const unread = (): number => {
      const cur = db.prepare('SELECT last_read_thread_seq FROM thread_participants WHERE thread_id=? AND session_id=?').get(T, OPERATOR_SESSION_ID) as { last_read_thread_seq: number };
      return (db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=? AND thread_sequence > ? AND sender_session_id <> ?').get(T, cur.last_read_thread_seq, OPERATOR_SESSION_ID) as { n: number }).n;
    };
    expect(unread()).toBe(0);
    // Session replies (seq 2) → now unread=1 for the operator.
    const injId = delivery.checkpointPull(hookAuth(auth), 'cp', 10).find((m) => m.messageId === t1.messageId)!.metadata![INJECTION_METADATA_KEY];
    delivery.ack(auth, { messageId: t1.messageId, status: 'accepted', injectionId: injId });
    delivery.reply(auth, { messageId: t1.messageId, text: 'a', outcome: 'completed', injectionId: injId }, allocSeq);
    expect(unread()).toBe(1);
    // Operator marks read up to seq 2 → unread back to 0. Idempotent + monotonic.
    const r = store.markThreadRead(T, 2);
    expect(r.lastReadThreadSeq).toBe(2);
    expect(unread()).toBe(0);
    expect(store.markThreadRead(T, 1).lastReadThreadSeq).toBe(2); // never rewinds
  });
});
