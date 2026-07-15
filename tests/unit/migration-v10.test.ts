/**
 * Migration v10 — beta.8: durable logical identity + name ownership (ADR 0027).
 *
 * Verifies the 9→10 upgrade on a POPULATED database (the reviewer's R6 — migration
 * completeness): a beta.7 session already holding a name gets a name_ownership row + a
 * backfilled logical_identity_id, so the name is reclaimable and the two name
 * representations (sessions columns vs name_ownership) never diverge at rest. All ADDITIVE —
 * no row lost, no v1..v9 migration edited (checksum-locked); the ledger is untouched.
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
function freshDb(): { db: SqliteDriver; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-mig10-'));
  dirs.push(dir);
  const p = path.join(dir, 'x.sqlite');
  return { db: openDatabase(p, { applyPragmas: true }), path: p };
}
afterEach(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } dirs.length = 0; });

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

/** A beta.7 session already holding an ACTIVE name (populated pre-v10). */
function insertNamedSession(db: SqliteDriver, id: string, name: string, now: string): void {
  db.prepare(`INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, state, session_name, normalized_session_name, session_name_state, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?, 'connected', ?,?, 'active', ?,?,?)`)
    .run(id, `session-${id.slice(0, 8)}`, 'p', '/', '0.1.0-beta.7', '[]', name, name.toLowerCase(), now, now, now);
}

describe('migration v10 — durable logical identity + name ownership', () => {
  it('the global head schema is 10 and the wire tuple is xbus-p1-stp1-s10', () => {
    expect(SCHEMA_VERSION).toBe(10);
    expect(WIRE_COMPATIBILITY_ID).toBe('xbus-p1-stp1-s10');
    expect(MIGRATIONS.some((m) => m.version === 10 && m.name === 'durable_logical_identity_and_name_ownership')).toBe(true);
  });

  it('creates name_ownership + physical_session_map + sessions.logical_identity_id on a fresh DB', () => {
    const { db } = freshDb();
    runMigrations(db, '2026-07-15T00:00:00.000Z');
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('name_ownership','physical_session_map')`).all() as Array<{ name: string }>).map((x) => x.name).sort();
    expect(tables).toEqual(['name_ownership', 'physical_session_map']);
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((x) => x.name);
    expect(cols).toContain('logical_identity_id');
  });

  it('9→10 on a populated DB backfills logical_identity_id + name_ownership (lossless, no divergence)', () => {
    const { db, path: p } = freshDb();
    const now = '2026-07-15T00:00:00.000Z';
    applyUpTo(db, 9, now);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='name_ownership'`).get() as { c: number }).c).toBe(0); // not yet
    const sid = 'aaaa7777-0000-4000-8000-000000000007';
    insertNamedSession(db, sid, 'seatmap-api', now);
    const before = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
    db.close();

    const db2 = openDatabase(p, { applyPragmas: true });
    const r = runMigrations(db2, now);
    expect(r.appliedNow).toEqual([10]);
    // no row lost
    expect((db2.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(before);
    // logical_identity_id backfilled = own session id
    expect((db2.prepare('SELECT logical_identity_id AS l FROM sessions WHERE session_id=?').get(sid) as { l: string }).l).toBe(sid);
    // name_ownership backfilled for the active-named session (owner_secret_hash NULL = legacy-unprotected)
    const own = db2.prepare(`SELECT logical_identity_id AS lid, normalized_name AS n, name_state AS s, current_session_id AS c, owner_secret_hash AS h FROM name_ownership WHERE normalized_name='seatmap-api'`).get() as { lid: string; n: string; s: string; c: string; h: string | null };
    expect(own.lid).toBe(sid);
    expect(own.s).toBe('active');
    expect(own.c).toBe(sid);
    expect(own.h).toBeNull();
    // the two name representations agree
    const sess = db2.prepare(`SELECT normalized_session_name AS n, session_name_state AS s FROM sessions WHERE session_id=?`).get(sid) as { n: string; s: string };
    expect(sess.n).toBe(own.n);
    expect(sess.s).toBe(own.s);
    db2.close();
  });

  it('does not create a name_ownership row for an UNNAMED legacy session', () => {
    const { db, path: p } = freshDb();
    const now = '2026-07-15T00:00:00.000Z';
    applyUpTo(db, 9, now);
    // unnamed session (no name columns)
    db.prepare(`INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, state, session_name_state, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?, 'connected', 'unnamed', ?,?,?)`)
      .run('bbbb0000-0000-4000-8000-000000000000', 'session-bbbb0000', 'p', '/', '0.1.0-beta.7', '[]', now, now, now);
    db.close();
    const db2 = openDatabase(p, { applyPragmas: true });
    runMigrations(db2, now);
    expect((db2.prepare(`SELECT COUNT(*) AS c FROM name_ownership`).get() as { c: number }).c).toBe(0);
    db2.close();
  });
});
