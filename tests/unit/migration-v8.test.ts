/**
 * Migration v8 — beta.6 Phase 2 threaded messaging + operator (ADR 0017 data model,
 * ADR 0021 operator identity + console).
 *
 * Verifies the 7→8 upgrade on a POPULATED database: legacy messages survive and gain
 * a coherent degenerate-thread backfill (thread_id = correlation_id, a monotonic
 * thread_sequence, author_type='claude'); the new threads/thread_participants/
 * thread_sequences tables + the messages.thread_id/thread_sequence/author_type columns
 * exist; a threads row + a thread_sequences cursor + claude participants are seeded from
 * the existing correlation groups; and the schema/compatibility version moves to
 * 8 / xbus-p1-stp1-s8 (the consciously-accepted, fail-closed whole-install bump — ADR 0019).
 * All ADDITIVE — no row is lost, no v1..v7 migration is edited (checksum-locked).
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/database/migrations.js';
import { FakeClock } from '../../src/shared/clock.js';
import { SCHEMA_VERSION, WIRE_COMPATIBILITY_ID } from '../../src/protocol/handshake.js';
import { createHash } from 'node:crypto';

const dirs: string[] = [];
function freshDb(): { db: SqliteDriver; dir: string; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-mig8-'));
  dirs.push(dir);
  const p = path.join(dir, 'x.sqlite');
  return { db: openDatabase(p, { applyPragmas: true }), dir, path: p };
}
afterEach(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } dirs.length = 0; });

/** Apply migrations up to (and including) `maxVersion`, mirroring runMigrations'
 *  transactional apply + checksum recording — so we can stop at v7 and observe the
 *  7→8 transition explicitly. */
function applyUpTo(db: SqliteDriver, maxVersion: number, nowIso: string): void {
  const cs = (sql: string): string => createHash('sha256').update(sql.replace(/\s+/g, ' ').trim(), 'utf8').digest('hex');
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version > maxVersion) break;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)').run(m.version, m.name, cs(m.sql), nowIso);
    });
  }
}

const NEW_TABLES = ['threads', 'thread_participants', 'thread_sequences'] as const;
const NEW_MSG_COLS = ['thread_id', 'thread_sequence', 'author_type'] as const;
function tableNames(db: SqliteDriver): Set<string> {
  return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((r) => r.name));
}
function messageColumns(db: SqliteDriver): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map((r) => r.name));
}

const A = 'aaaa8888-0000-4000-8000-00000000000a';
const B = 'bbbb8888-0000-4000-8000-00000000000b';

/**
 * Seed a legacy v7 conversation the way a real beta.5.1 broker wrote it: raw INSERTs
 * against the v7 `messages`/`deliveries` schema (which has NO thread_id/thread_sequence/
 * author_type columns). A request + a correlated reply share one correlation_id — the exact
 * shape the v8 backfill must turn into a coherent degenerate thread. NOTE: we cannot call
 * the current BrokerStore.send() here — post-v8 it references the thread tables, which don't
 * exist until v8 runs. Raw inserts faithfully reproduce pre-v8 rows.
 */
function seedV7Conversation(db: SqliteDriver, nowIso: string): { correlationId: string; requestId: string; replyId: string } {
  // Minimal session rows so any downstream reads are coherent (v7 schema).
  const mkSession = (id: string): void => {
    db.prepare(`INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, state, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?, 'connected', ?,?,?)`)
      .run(id, `session-${id.slice(0, 8)}`, 'p', '/', '0.1.0-beta.5.1', '[]', nowIso, nowIso, nowIso);
    db.prepare('INSERT OR IGNORE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, 1)').run(id);
  };
  mkSession(A); mkSession(B);
  const requestId = '11111111-1111-4111-8111-111111111111';
  const replyId = '22222222-2222-4222-8222-222222222222';
  const correlationId = requestId; // root: correlation == messageId (the pre-v8 convention)
  const mReq = `INSERT INTO messages (message_id, protocol_version, sender_session_id, sender_alias, recipient_session_id, recipient_alias, kind, correlation_id, causation_id, parent_message_id, recipient_sequence, body_text, body_hash, requires_ack, requires_reply, created_at, trace_id) VALUES (?,1,?,?,?,?, 'request', ?, NULL, NULL, 1, 'hello', 'h', 1, 1, ?, 'tr')`;
  db.prepare(mReq).run(requestId, A, 'session-aaaa8888', B, 'session-bbbb8888', correlationId, nowIso);
  const laterIso = new Date(Date.parse(nowIso) + 1000).toISOString();
  const mRep = `INSERT INTO messages (message_id, protocol_version, sender_session_id, sender_alias, recipient_session_id, recipient_alias, kind, correlation_id, causation_id, parent_message_id, recipient_sequence, body_text, body_hash, requires_ack, requires_reply, created_at, trace_id) VALUES (?,1,?,?,?,?, 'reply', ?, ?, ?, 1, 'hi back', 'h2', 0, 0, ?, 'tr')`;
  db.prepare(mRep).run(replyId, B, 'session-bbbb8888', A, 'session-aaaa8888', correlationId, requestId, requestId, laterIso);
  db.prepare(`INSERT INTO deliveries (delivery_id, message_id, recipient_session_id, state, created_at, updated_at) VALUES ('d1', ?, ?, 'completed', ?, ?)`).run(requestId, B, nowIso, nowIso);
  db.prepare(`INSERT INTO deliveries (delivery_id, message_id, recipient_session_id, state, created_at, updated_at) VALUES ('d2', ?, ?, 'queued', ?, ?)`).run(replyId, A, laterIso, laterIso);
  return { correlationId, requestId, replyId };
}

describe('migration v8 — schema/version bump', () => {
  it('the global schema is exactly 8 and the wire tuple is xbus-p1-stp1-s8', () => {
    expect(SCHEMA_VERSION).toBe(8);
    expect(WIRE_COMPATIBILITY_ID).toBe('xbus-p1-stp1-s8');
    expect(MIGRATIONS.some((m) => m.version === 8 && m.name === 'threaded_messaging_and_operator')).toBe(true);
  });

  it('applying up to v8 on a fresh DB creates the thread tables + message columns', () => {
    const { db } = freshDb();
    applyUpTo(db, 8, '2026-01-01T00:00:00.000Z');
    const tables = tableNames(db);
    for (const t of NEW_TABLES) expect(tables.has(t), `table ${t} missing`).toBe(true);
    const cols = messageColumns(db);
    for (const c of NEW_MSG_COLS) expect(cols.has(c), `messages.${c} missing`).toBe(true);
    // author_type defaults 'claude'; thread_id/thread_sequence are nullable (no rows yet).
    const info = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string; dflt_value: string | null; notnull: number }>;
    const authorType = info.find((c) => c.name === 'author_type')!;
    expect(authorType.notnull).toBe(1);
    expect(String(authorType.dflt_value)).toContain('claude');
    db.close();
  });

  it('thread_participants enforces UNIQUE(thread_id, session_id) and FK to threads', () => {
    const { db } = freshDb();
    const now = '2026-01-01T00:00:00.000Z';
    applyUpTo(db, 8, now);
    db.prepare(`INSERT INTO threads (thread_id, root_message_id, created_by_actor, state, created_at, updated_at, last_message_at) VALUES ('t1','m1','local-operator','open',?,?,?)`).run(now, now, now);
    db.prepare(`INSERT INTO thread_participants (participant_id, thread_id, session_id, actor_kind, participant_role, joined_at) VALUES ('p1','t1','sess-a','claude','member',?)`).run(now);
    // Duplicate (thread, session) rejected.
    expect(() => db.prepare(`INSERT INTO thread_participants (participant_id, thread_id, session_id, actor_kind, participant_role, joined_at) VALUES ('p2','t1','sess-a','claude','member',?)`).run(now)).toThrow();
    // FK to a non-existent thread rejected (foreign_keys=ON for the writer).
    expect(() => db.prepare(`INSERT INTO thread_participants (participant_id, thread_id, session_id, actor_kind, participant_role, joined_at) VALUES ('p3','nope','sess-b','claude','member',?)`).run(now)).toThrow();
    db.close();
  });
});

describe('migration v8 — 7→8 on a populated DB (backfill)', () => {
  it('a legacy conversation survives and becomes a coherent degenerate thread', () => {
    const { db, path: p } = freshDb();
    const clock = new FakeClock();
    const now = clock.nowIso();
    applyUpTo(db, 7, now);
    expect(messageColumns(db).has('thread_id')).toBe(false); // not yet
    const { correlationId, requestId } = seedV7Conversation(db, now);
    const before = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(before).toBe(2); // request + correlated reply
    db.close();

    // Real 7→8 upgrade via runMigrations (the exact production path).
    const db2 = openDatabase(p, { applyPragmas: true });
    const r = runMigrations(db2, now);
    expect(r.appliedNow).toEqual([8]); // only v8 applied on the already-v7 DB
    expect(r.currentVersion).toBe(8);

    // No message lost.
    const after = (db2.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(after).toBe(before);

    // Every legacy message: thread_id = correlation_id, author_type='claude', a thread_sequence.
    const rows = db2.prepare('SELECT message_id, thread_id, thread_sequence, author_type, correlation_id FROM messages').all() as Array<{ message_id: string; thread_id: string | null; thread_sequence: number | null; author_type: string; correlation_id: string }>;
    for (const m of rows) {
      expect(m.thread_id).toBe(m.correlation_id);
      expect(m.author_type).toBe('claude');
      expect(m.thread_sequence).not.toBeNull();
      expect(m.thread_sequence).toBeGreaterThanOrEqual(1);
    }
    // thread_sequence is unique per thread (no gaps/dupes) — the root request is seq 1.
    const seqs = rows.filter((m) => m.thread_id === correlationId).map((m) => m.thread_sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));

    // A threads row was seeded with the correct root + last_thread_sequence.
    const thread = db2.prepare('SELECT root_message_id, last_thread_sequence, created_by_actor, state FROM threads WHERE thread_id=?').get(correlationId) as { root_message_id: string; last_thread_sequence: number; created_by_actor: string; state: string } | undefined;
    expect(thread).toBeDefined();
    expect(thread!.root_message_id).toBe(requestId);
    expect(thread!.state).toBe('open');
    expect(thread!.last_thread_sequence).toBe(seqs.length);
    expect(thread!.created_by_actor).toBe(A); // the root sender

    // thread_sequences cursor is one past the last assigned sequence.
    const cursor = db2.prepare('SELECT next_sequence FROM thread_sequences WHERE thread_id=?').get(correlationId) as { next_sequence: number };
    expect(cursor.next_sequence).toBe(seqs.length + 1);

    // Both sender + recipient are seeded as claude participants of the thread.
    const parts = (db2.prepare('SELECT session_id FROM thread_participants WHERE thread_id=? ORDER BY session_id').all(correlationId) as Array<{ session_id: string }>).map((x) => x.session_id);
    expect(parts).toContain(A);
    expect(parts).toContain(B);
    for (const sid of parts) {
      const k = db2.prepare('SELECT actor_kind FROM thread_participants WHERE thread_id=? AND session_id=?').get(correlationId, sid) as { actor_kind: string };
      expect(k.actor_kind).toBe('claude'); // operator is provisioned at runtime, not in the migration
    }
    db2.close();
  });

  it('the 7→8 migration is idempotent-safe (re-run applies nothing, checksum verified)', () => {
    const { db, path: p } = freshDb();
    const now = '2026-01-01T00:00:00.000Z';
    runMigrations(db, now); // straight to 8
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(8);
    db.close();
    const db2 = openDatabase(p, { applyPragmas: true });
    const r = runMigrations(db2, now); // no-op; checksum of v8 must match
    expect(r.appliedNow).toEqual([]);
    expect(r.currentVersion).toBe(8);
    db2.close();
  });
});
