/**
 * Migration v6 — beta.4 named sessions + 15-day retention schema (ADR 0012).
 *
 * Verifies the 5→6 upgrade on a POPULATED database: a legacy session row written
 * under the v1..v5 schema must survive the migration with safe defaults
 * (session_name_state='unnamed', name columns NULL), the new columns must exist,
 * the active-name partial unique index must enforce case-insensitive uniqueness
 * across active/pending sessions, and the schema/compatibility version must move to
 * 6 / xbus-p1-stp1-s6 (the consciously-accepted, fail-closed bump — §3 of the ADR).
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/database/migrations.js';
import { SCHEMA_VERSION, WIRE_COMPATIBILITY_ID } from '../../src/protocol/handshake.js';
import { createHash } from 'node:crypto';

const dirs: string[] = [];
function freshDb(): { db: SqliteDriver; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-mig6-'));
  dirs.push(dir);
  return { db: openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true }), dir };
}
afterEach(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } dirs.length = 0; });

/** Apply migrations up to (and including) `maxVersion`, mirroring runMigrations'
 *  transactional apply + checksum recording — so we can stop at v5 and observe the
 *  5→6 transition explicitly. */
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

const COLS = ['session_name', 'normalized_session_name', 'session_name_state', 'last_meaningful_activity_at', 'expired_at', 'expiration_reason', 'pending_name_expires_at', 'agent_type'] as const;
function sessionColumns(db: SqliteDriver): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((r) => r.name));
}
/** Insert a minimal legacy session row valid under the v1..v5 schema (no v6 cols). */
function insertLegacySession(db: SqliteDriver, sessionId: string, nowIso: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, state, last_seen_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(sessionId, `session-${sessionId.slice(0, 8)}`, 'p', '/', '0.1.0-beta.3', '[]', 'connected', nowIso, nowIso, nowIso);
}

describe('migration v6 — schema/version bump', () => {
  it('migration v6 exists and moves the schema to exactly 6 at its boundary', () => {
    // v6 is the beta.4 boundary. The GLOBAL current schema/wire tuple has since moved
    // forward (owned by version-consistency.test.ts + migration-v7.test.ts); this file
    // stays scoped to the v6 migration itself, so it asserts the 6-boundary via a
    // bounded apply — not the global SCHEMA_VERSION (which is now higher).
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    expect(WIRE_COMPATIBILITY_ID).toMatch(/^xbus-p1-stp1-s\d+$/);
    expect(MIGRATIONS.some((m) => m.version === 6 && m.name === 'named_sessions_and_activity_retention')).toBe(true);
    const { db } = freshDb();
    applyUpTo(db, 6, '2026-01-01T00:00:00.000Z');
    const cur = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
    expect(cur).toBe(6);
    db.close();
  });

  it('applying up to v6 on a fresh DB creates the v6 columns with safe defaults', () => {
    const { db } = freshDb();
    applyUpTo(db, 6, '2026-01-01T00:00:00.000Z');
    const cols = sessionColumns(db);
    for (const c of COLS) expect(cols.has(c), `sessions.${c} missing`).toBe(true);
    db.close();
  });
});

describe('migration v6 — 5→6 on a populated DB', () => {
  it('a legacy session row survives with safe defaults (unnamed, NULL name)', () => {
    const { db } = freshDb();
    const now = '2026-01-01T00:00:00.000Z';
    applyUpTo(db, 5, now);
    expect(sessionColumns(db).has('session_name')).toBe(false); // not yet
    insertLegacySession(db, 'aaaaaaaa-0000-4000-8000-000000000001', now);
    // Now apply v6.
    runMigrations(db, now);
    const cols = sessionColumns(db);
    for (const c of COLS) expect(cols.has(c), `sessions.${c} missing after 5->6`).toBe(true);
    const row = db.prepare('SELECT session_name, normalized_session_name, session_name_state, expired_at, last_meaningful_activity_at FROM sessions WHERE session_id=?')
      .get('aaaaaaaa-0000-4000-8000-000000000001') as { session_name: string | null; normalized_session_name: string | null; session_name_state: string; expired_at: string | null; last_meaningful_activity_at: string | null };
    expect(row.session_name).toBeNull();
    expect(row.normalized_session_name).toBeNull();
    expect(row.session_name_state).toBe('unnamed'); // safe default — legacy session stays routable by alias
    expect(row.expired_at).toBeNull();
    // Beta.4: the retention clock is BACKFILLED for upgraded sessions (anchored on
    // last_seen_at) so they participate in 15-day expiry from upgrade time — NOT NULL.
    expect(row.last_meaningful_activity_at).not.toBeNull();
    const e = db.prepare('SELECT expires_at AS x FROM sessions WHERE session_id=?').get('aaaaaaaa-0000-4000-8000-000000000001') as { x: string | null };
    expect(e.x).not.toBeNull();
    expect(e.x).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // exact JS ISO format
    db.close();
  });

  it('ux_session_name_active enforces case-insensitive uniqueness across active+pending, but allows retired reuse', () => {
    const { db } = freshDb();
    const now = '2026-01-01T00:00:00.000Z';
    runMigrations(db, now);
    const mk = (id: string, name: string | null, norm: string | null, state: string): void => {
      insertLegacySession(db, id, now);
      db.prepare('UPDATE sessions SET session_name=?, normalized_session_name=?, session_name_state=? WHERE session_id=?').run(name, norm, state, id);
    };
    // First active 'app-a'.
    mk('11111111-0000-4000-8000-000000000001', 'App-A', 'app-a', 'active');
    // A second ACTIVE row with the same normalized name must be rejected.
    expect(() => mk('22222222-0000-4000-8000-000000000002', 'app-a', 'app-a', 'active')).toThrow();
    // A PENDING row with that name is ALSO rejected (reserve-on-claim).
    expect(() => mk('33333333-0000-4000-8000-000000000003', 'app-a', 'app-a', 'pending')).toThrow();
    // Retiring the first frees the name for a new active claim.
    db.prepare("UPDATE sessions SET session_name_state='retired' WHERE session_id=?").run('11111111-0000-4000-8000-000000000001');
    expect(() => mk('44444444-0000-4000-8000-000000000004', 'app-a', 'app-a', 'active')).not.toThrow();
    db.close();
  });

  it('unnamed/retired rows with NULL normalized name do not collide (partial index)', () => {
    const { db } = freshDb();
    const now = '2026-01-01T00:00:00.000Z';
    runMigrations(db, now);
    insertLegacySession(db, '55555555-0000-4000-8000-000000000005', now);
    insertLegacySession(db, '66666666-0000-4000-8000-000000000006', now);
    // Both default to 'unnamed' + NULL normalized_session_name → no unique-index collision.
    const cnt = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_name_state='unnamed'").get() as { n: number }).n;
    expect(cnt).toBe(2);
    db.close();
  });
});
