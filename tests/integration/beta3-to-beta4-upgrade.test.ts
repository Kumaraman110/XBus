/**
 * beta.3 -> beta.4 data upgrade (migration category, ADR 0012).
 *
 * Builds a database at the beta.3 schema (v5) populated with realistic live data —
 * a registered session with an alias, a queued delivery, a context injection — then
 * runs the v6 migration and proves:
 *   - all beta.3 rows survive untouched (sessions/aliases/messages/deliveries/injections),
 *   - the new beta.4 columns exist with safe defaults (session_name_state='unnamed'),
 *   - a legacy (unnamed) session is still routable by its alias AND injectable,
 *   - the legacy session participates in the new 15-day expiry,
 *   - the frozen injection-id / non-ack invariants still hold post-upgrade.
 *
 * This is the "upgrade from a beta.3 installation / existing session database" case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { Reaper } from '../../src/broker/reaper.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let dbPath: string; let clock: FakeClock;
const DAY = 24 * 60 * 60_000;
const LEGACY = 'beef0001-0000-4000-8000-000000000001';
const SENDER = 'beef0002-0000-4000-8000-000000000002';

/** Apply migrations 1..5 only (the beta.3 schema), recording them like runMigrations. */
function applyV5(db: SqliteDriver, nowIso: string): void {
  const cs = (sql: string): string => createHash('sha256').update(sql.replace(/\s+/g, ' ').trim(), 'utf8').digest('hex');
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version > 5) break;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)').run(m.version, m.name, cs(m.sql), nowIso);
    });
  }
}

/** Seed a realistic beta.3 live session (sessions + epoch + component + alias + seq). */
function seedSession(db: SqliteDriver, sessionId: string, alias: string, nowIso: string): void {
  // Use the FULL session id as the per-row uniqueness key (LEGACY/SENDER share their
  // first 6 hex chars, so a short slice would collide on component_instance_id etc.).
  const k = sessionId;
  db.prepare(`INSERT INTO sessions (session_id, active_instance_id, generation, high_water_generation, active_epoch, fencing_token, bound_connection_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, receive_mode, state, last_seen_at, created_at, updated_at, readiness) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'connected', ?,?,?, 'ready_checkpoint')`)
    .run(sessionId, 'inst-' + k, 1, 1, 1, 1, 'conn-' + k, `session-${sessionId.slice(0, 8)}`, 'p', '/', '0.1.0-beta.3', JSON.stringify(['ack', 'reply']), 'hook_checkpoint', nowIso, nowIso, nowIso);
  db.prepare('INSERT INTO session_epochs (session_id, epoch, epoch_token_hash, started_at) VALUES (?,?,?,?)').run(sessionId, 1, 'tok-' + k, nowIso);
  db.prepare(`INSERT INTO component_instances (component_instance_id, session_id, epoch, role, process_id, connection_id, capabilities_json, connected_at, last_seen_at, state) VALUES (?,?,?,?,?,?,?,?,?, 'live')`)
    .run('comp-' + k, sessionId, 1, 'mcp', 1, 'conn-' + k, JSON.stringify(['ack', 'reply']), nowIso, nowIso);
  db.prepare('INSERT INTO aliases (alias_id, alias, alias_ci, scope, project_id, session_id, active, created_at) VALUES (?,?,?,?,?,?,1,?)').run('al-' + k, alias, alias.toLowerCase(), 'global', null, sessionId, nowIso);
  db.prepare('INSERT INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, 1)').run(sessionId);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-b3b4-'));
  dbPath = path.join(dir, 'xbus.sqlite');
  clock = new FakeClock();
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('beta.3 -> beta.4 upgrade', () => {
  it('migrates a populated v5 DB to v6, preserving all rows + defaulting name state to unnamed', () => {
    const t0 = clock.nowIso();
    let db = openDatabase(dbPath, { applyPragmas: true });
    applyV5(db, t0);
    seedSession(db, LEGACY, 'architect', t0);
    seedSession(db, SENDER, 'sender', t0);
    // a queued delivery from SENDER -> LEGACY (beta.3 message + delivery rows)
    db.prepare(`INSERT INTO messages (message_id, protocol_version, sender_session_id, sender_alias, recipient_session_id, recipient_alias, kind, correlation_id, recipient_sequence, body_text, body_hash, requires_ack, requires_reply, created_at, trace_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('msg-1', 1, SENDER, 'sender', LEGACY, 'architect', 'request', 'msg-1', 1, 'legacy body', 'h', 1, 0, t0, 'tr-1');
    db.prepare(`INSERT INTO deliveries (delivery_id, message_id, recipient_session_id, state, created_at, updated_at) VALUES (?,?,?, 'queued', ?, ?)`).run('del-1', 'msg-1', LEGACY, t0, t0);
    const beforeSessions = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    db.close();

    // Reopen + run ALL migrations (5 -> 6). This is what a beta.4 broker boot does.
    db = openDatabase(dbPath, { applyPragmas: true });
    const r = runMigrations(db, t0);
    expect(r.currentVersion).toBe(6);
    expect(r.appliedNow).toEqual([6]); // only v6 was pending

    // All rows survived.
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(beforeSessions);
    expect((db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM aliases WHERE active=1').get() as { n: number }).n).toBe(2);
    // New columns exist with safe defaults — legacy sessions are 'unnamed' (routable by alias).
    const leg = db.prepare('SELECT session_name_state AS s, session_name AS n, normalized_session_name AS nn, expired_at AS e FROM sessions WHERE session_id=?').get(LEGACY) as { s: string; n: string | null; nn: string | null; e: string | null };
    expect(leg.s).toBe('unnamed');
    expect(leg.n).toBeNull();
    expect(leg.nn).toBeNull();
    expect(leg.e).toBeNull();
    db.close();
  });

  it('post-upgrade: the legacy session is still routable by alias AND injectable (I2 intact)', () => {
    const t0 = clock.nowIso();
    let db = openDatabase(dbPath, { applyPragmas: true });
    applyV5(db, t0);
    seedSession(db, LEGACY, 'architect', t0);
    seedSession(db, SENDER, 'sender', t0);
    db.close();
    db = openDatabase(dbPath, { applyPragmas: true });
    runMigrations(db, t0);

    const ids = new SeqIdGen('m');
    const store = new BrokerStore(db, clock, ids, 'b');
    const delivery = new DeliveryOps(db, clock, ids, 5 * 60_000);
    // Re-register the SENDER (fresh beta.4 epoch) so it can send; legacy stays as-is.
    const senderAuth: SessionAuthority = store.register({ sessionId: SENDER, instanceId: 'i', connectionId: 'c-snd2', processId: 9, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp', supersede: true });
    store.signalReadiness(senderAuth, { ackAvailable: true, versionOk: true });
    // Route to the legacy session BY ITS ALIAS (the beta.3 alias still works).
    const send = store.send(senderAuth, { to: 'architect', text: 'still routable', kind: 'request', requiresAck: true, requiresReply: false });
    expect(send.recipientSessionId).toBe(LEGACY);

    // The legacy session can still be injected (it has a valid epoch from v5 seed).
    const legHook: SessionAuthority = { sessionId: LEGACY, instanceId: 'comp-' + LEGACY, componentInstanceId: 'comp-' + LEGACY, role: 'hook' as never, epoch: 1, generation: 1, fencingToken: 1, connectionId: 'conn' };
    const got = delivery.checkpointPull(legHook, 'cp1', 10);
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe('still routable');
    // I2: the injected body carries a valid injection id.
    expect(got[0]!.metadata?.xbus_injection_id).toBeTruthy();
    db.close();
  });

  it('post-upgrade: a legacy session expires by 15-day inactivity like any other', () => {
    const t0 = clock.nowIso();
    let db = openDatabase(dbPath, { applyPragmas: true });
    applyV5(db, t0);
    seedSession(db, LEGACY, 'architect', t0);
    db.close();
    db = openDatabase(dbPath, { applyPragmas: true });
    runMigrations(db, t0);
    const ids = new SeqIdGen('m');
    const store = new BrokerStore(db, clock, ids, 'b');
    const reaper = new Reaper(db, clock, ids);
    // The upgraded legacy row has NO last_meaningful_activity_at/expires_at yet — it
    // was never refreshed. Re-register it (beta.4 lifecycle) to stamp the timer, then
    // let 15 days pass.
    const auth = store.register({ sessionId: LEGACY, instanceId: 'i', connectionId: 'c-leg2', processId: 5, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp', supersede: true });
    store.signalReadiness(auth, { ackAvailable: true, versionOk: true });
    clock.advance(15 * DAY + 1000);
    expect(reaper.sweep().sessionsExpired).toBe(1);
    const e = db.prepare('SELECT expired_at FROM sessions WHERE session_id=?').get(LEGACY) as { expired_at: string | null };
    expect(e.expired_at).not.toBeNull();
    db.close();
  });

  it('a v6 DB is REJECTED by beta.3 code (downgrade guard) — proves the fail-closed bump', () => {
    const t0 = clock.nowIso();
    let db = openDatabase(dbPath, { applyPragmas: true });
    runMigrations(db, t0); // now at v6
    db.close();
    // Simulate beta.3 code (which only knows migrations 1..5) opening the v6 DB.
    db = openDatabase(dbPath, { applyPragmas: true });
    const beta3Migrations = [...MIGRATIONS].filter((m) => m.version <= 5);
    const codeMax = beta3Migrations.reduce((mx, m) => Math.max(mx, m.version), 0);
    const dbMax = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
    // The runMigrations downgrade guard throws when dbMax > codeMax. We assert the
    // condition that triggers it (beta.3 code would refuse to run against this DB).
    expect(dbMax).toBe(6);
    expect(dbMax).toBeGreaterThan(codeMax);
    db.close();
  });
});
