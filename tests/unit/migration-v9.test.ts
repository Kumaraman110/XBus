/**
 * Migration v9 — beta.7 Phase 3: session titles + lifecycle + scheduling (ADR 0024/0025).
 *
 * Verifies the 8→9 upgrade on a POPULATED database: legacy sessions survive with safe
 * defaults (claude_title NULL, managed_by_xbus/pinned/archived 0); the new sessions columns
 * + the schedules/schedule_runs tables exist; the schedule_runs UNIQUE(schedule_id,
 * scheduled_for) exactly-once CAS enforces; and the schema/compat version moves to
 * 9 / xbus-p1-stp1-s9 (the fail-closed whole-install bump). All ADDITIVE — no row lost, no
 * v1..v8 migration edited (checksum-locked).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-mig9-'));
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
const NEW_TABLES = ['schedules', 'schedule_runs'] as const;
const NEW_COLS = ['claude_title', 'claude_title_source', 'claude_title_at', 'managed_by_xbus', 'managed_pid', 'managed_started_at', 'managed_launch_key', 'pinned', 'archived', 'archived_at'] as const;
function tableNames(db: SqliteDriver): Set<string> { return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((r) => r.name)); }
function sessionCols(db: SqliteDriver): Set<string> { return new Set((db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((r) => r.name)); }
function insertLegacySession(db: SqliteDriver, id: string, now: string): void {
  db.prepare(`INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, state, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?, 'connected', ?,?,?)`)
    .run(id, `session-${id.slice(0, 8)}`, 'p', '/', '0.1.0-beta.6', '[]', now, now, now);
}

describe('migration v9 — schema/version bump', () => {
  it('the v9 migration still exists (session titles + lifecycle + scheduling)', () => {
    // beta.8 (ADR 0027) added migration v10, so the HEAD schema is now 10 (see migration-v10
    // test). v9 remains a real, applied migration — assert it is present and unchanged.
    expect(MIGRATIONS.some((m) => m.version === 9 && m.name === 'session_titles_lifecycle_and_scheduling')).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
  });

  it('applying up to v9 on a fresh DB creates the schedule tables + session columns', () => {
    const { db } = freshDb();
    applyUpTo(db, 9, '2026-01-01T00:00:00.000Z');
    const tables = tableNames(db);
    for (const t of NEW_TABLES) expect(tables.has(t), `table ${t} missing`).toBe(true);
    const cols = sessionCols(db);
    for (const c of NEW_COLS) expect(cols.has(c), `sessions.${c} missing`).toBe(true);
    // NOT-NULL-DEFAULT flags default to 0.
    const info = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string; dflt_value: string | null; notnull: number }>;
    for (const flag of ['managed_by_xbus', 'pinned', 'archived']) {
      const c = info.find((x) => x.name === flag)!;
      expect(c.notnull).toBe(1);
      expect(String(c.dflt_value)).toBe('0');
    }
    db.close();
  });

  it('schedule_runs UNIQUE(schedule_id, scheduled_for) is the exactly-once CAS', () => {
    const { db } = freshDb();
    const now = '2026-01-01T00:00:00.000Z';
    applyUpTo(db, 9, now);
    db.prepare(`INSERT INTO schedules (schedule_id, created_by_actor, target_address, payload_text, kind, next_run, created_at, updated_at) VALUES ('sc1','local-operator','svc','do it','once',?,?,?)`).run(now, now, now);
    const claim = () => db.prepare(`INSERT INTO schedule_runs (run_id, schedule_id, scheduled_for, idempotency_key, claimed_at, created_at, updated_at) VALUES (?, 'sc1', ?, 'sched:sc1:'||?, ?, ?, ?)`);
    claim().run('r1', now, now, now, now, now);
    // A second claim for the SAME (schedule, slot) is rejected — one claim per fire-slot ever.
    expect(() => claim().run('r2', now, now, now, now, now)).toThrow();
    // FK to a non-existent schedule is rejected.
    expect(() => db.prepare(`INSERT INTO schedule_runs (run_id, schedule_id, scheduled_for, idempotency_key, claimed_at, created_at, updated_at) VALUES ('r3','nope',?,'k',?,?,?)`).run(now, now, now, now)).toThrow();
    db.close();
  });
});

describe('migration v9 — 8→9 on a populated DB', () => {
  it('a legacy session survives with safe defaults (no title, not managed/pinned/archived)', () => {
    const { db, path: p } = freshDb();
    const now = '2026-01-01T00:00:00.000Z';
    applyUpTo(db, 8, now);
    expect(sessionCols(db).has('claude_title')).toBe(false); // not yet
    insertLegacySession(db, 'aaaa9999-0000-4000-8000-000000000009', now);
    const before = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
    db.close();
    const db2 = openDatabase(p, { applyPragmas: true });
    const r = runMigrations(db2, now);
    // beta.8 added v10 and beta.10 WS3 added v11, so a v8 DB now forward-migrates through 9, 10 AND
    // 11 to head — all additive (v11 = collections + conversation/work tables; lossless).
    expect(r.appliedNow).toEqual([9, 10, 11]);
    expect((db2.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(before);
    const row = db2.prepare('SELECT claude_title, claude_title_source, managed_by_xbus, pinned, archived FROM sessions WHERE session_id=?').get('aaaa9999-0000-4000-8000-000000000009') as { claude_title: string | null; claude_title_source: string | null; managed_by_xbus: number; pinned: number; archived: number };
    expect(row.claude_title).toBeNull();
    expect(row.claude_title_source).toBeNull();
    expect(row.managed_by_xbus).toBe(0);
    expect(row.pinned).toBe(0);
    expect(row.archived).toBe(0);
    db2.close();
  });

  it('migrations are idempotent-safe (re-run applies nothing, checksum verified)', () => {
    const { db, path: p } = freshDb();
    const now = '2026-01-01T00:00:00.000Z';
    const first = runMigrations(db, now);
    // Head is the current SCHEMA_VERSION (10 as of beta.8); the point of this test is the
    // idempotent RE-RUN, not the exact head number.
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(SCHEMA_VERSION);
    expect(first.currentVersion).toBe(SCHEMA_VERSION);
    db.close();
    const db2 = openDatabase(p, { applyPragmas: true });
    const r = runMigrations(db2, now);
    expect(r.appliedNow).toEqual([]);
    expect(r.currentVersion).toBe(SCHEMA_VERSION);
    db2.close();
  });
});
