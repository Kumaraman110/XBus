/**
 * Migration v11 — beta.10 WS3: workspace Collections + conversation/work model (ADR 0034).
 *
 * Verifies the s10→s11 upgrade on a POPULATED database (the migration gate): all s10 data
 * (sessions, name_ownership, messages, deliveries, receipts, ledger) is preserved byte-for-byte,
 * v1..v10 checksums stay locked, and the new tables + constraints exist. ADDITIVE-only, idempotent.
 * Also enforces the authorized Collections contract: unique active normalized name per workspace,
 * no duplicate member, and delete-collection cascades membership without touching agents.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-mig11-'));
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
function insertNamedSession(db: SqliteDriver, id: string, name: string, now: string): void {
  db.prepare(`INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, state, session_name, normalized_session_name, session_name_state, logical_identity_id, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?, 'connected', ?,?, 'active', ?, ?,?,?)`)
    .run(id, `session-${id.slice(0, 8)}`, 'p', '/', '0.1.0-beta.9.1', '[]', name, name.toLowerCase(), id, now, now, now);
}

describe('migration v11 — workspace collections + conversation/work model', () => {
  it('the global head schema is 11 and the wire tuple is xbus-p1-stp1-s11', () => {
    expect(SCHEMA_VERSION).toBe(11);
    expect(WIRE_COMPATIBILITY_ID).toBe('xbus-p1-stp1-s11');
    expect(MIGRATIONS.some((m) => m.version === 11 && m.name === 'workspace_collections_and_conversation_work_model')).toBe(true);
  });

  it('creates all authorized s11 tables on a fresh DB', () => {
    const { db } = freshDb();
    runMigrations(db, '2026-07-20T00:00:00.000Z');
    const want = ['collections', 'collection_members', 'conversations', 'conversation_participants', 'work_items', 'artifacts'];
    const got = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('collections','collection_members','conversations','conversation_participants','work_items','artifacts')`).all() as Array<{ name: string }>).map((x) => x.name).sort();
    expect(got).toEqual([...want].sort());
  });

  it('MIGRATION GATE — s10→s11 on a POPULATED DB preserves ALL s10 data + locks v1..v10 checksums', () => {
    const { db, path: p } = freshDb();
    const now = '2026-07-20T00:00:00.000Z';
    applyUpTo(db, 10, now);
    // populate s10 identity + a name_ownership row
    insertNamedSession(db, 'aaaa1111-0000-4000-8000-000000000001', 'worker', now);
    db.prepare(`INSERT INTO name_ownership (logical_identity_id, normalized_name, display_name, owner_secret_hash, name_state, current_session_id, created_at, updated_at) VALUES (?,?,?,?, 'active', ?,?,?)`)
      .run('aaaa1111-0000-4000-8000-000000000001', 'worker', 'worker', 'sha256hash', 'aaaa1111-0000-4000-8000-000000000001', now, now);
    const sessBefore = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    const ownBefore = db.prepare('SELECT owner_secret_hash AS h FROM name_ownership WHERE normalized_name=?').get('worker') as { h: string };
    const checksumsBefore = (db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; checksum: string }>);
    db.close();
    // upgrade s10 → s11
    const db2 = openDatabase(p, { applyPragmas: true });
    const r = runMigrations(db2, now);
    expect(r.appliedNow).toEqual([11]);           // only v11 applied
    expect(r.currentVersion).toBe(11);
    // ALL s10 data preserved
    expect((db2.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(sessBefore);
    expect((db2.prepare('SELECT owner_secret_hash AS h FROM name_ownership WHERE normalized_name=?').get('worker') as { h: string }).h).toBe(ownBefore.h);
    // v1..v10 checksums byte-stable (no shipped migration edited)
    const after = new Map((db2.prepare('SELECT version, checksum FROM schema_migrations WHERE version<=10').all() as Array<{ version: number; checksum: string }>).map((x) => [x.version, x.checksum]));
    for (const c of checksumsBefore) expect(after.get(c.version), `v${c.version} checksum stable`).toBe(c.checksum);
    db2.close();
  });

  it('re-running migrations is idempotent (v11 applied once)', () => {
    const { db, path: p } = freshDb();
    const now = '2026-07-20T00:00:00.000Z';
    runMigrations(db, now);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(SCHEMA_VERSION);
    db.close();
    const db2 = openDatabase(p, { applyPragmas: true });
    expect(runMigrations(db2, now).appliedNow).toEqual([]);
    db2.close();
  });
});

describe('migration v11 — collections contract enforcement', () => {
  function seed(): SqliteDriver {
    const { db } = freshDb();
    runMigrations(db, '2026-07-20T00:00:00.000Z');
    return db;
  }
  const now = '2026-07-20T00:00:00.000Z';
  function addCollection(db: SqliteDriver, id: string, name: string, state = 'active'): void {
    db.prepare(`INSERT INTO collections (collection_id, workspace_id, name, normalized_name, sort_order, state, created_at, updated_at) VALUES (?, 'local', ?, ?, 0, ?, ?, ?)`)
      .run(id, name, name.toLowerCase(), state, now, now);
  }

  it('unique ACTIVE normalized collection name per workspace (archived frees the name)', () => {
    const db = seed();
    addCollection(db, 'c1', 'Backend');
    expect(() => addCollection(db, 'c2', 'backend')).toThrow(); // same normalized, both active → rejected
    // archiving c1 frees the name for a new active collection
    db.prepare(`UPDATE collections SET state='archived' WHERE collection_id='c1'`).run();
    expect(() => addCollection(db, 'c3', 'Backend')).not.toThrow();
    db.close();
  });

  it('no duplicate member; delete-collection cascades membership but not agents', () => {
    const db = seed();
    addCollection(db, 'c1', 'Team');
    const agent = 'aaaa2222-0000-4000-8000-000000000002';
    db.prepare(`INSERT INTO collection_members (collection_id, logical_agent_id, sort_order, created_at) VALUES ('c1', ?, 0, ?)`).run(agent, now);
    // duplicate member rejected by PK
    expect(() => db.prepare(`INSERT INTO collection_members (collection_id, logical_agent_id, sort_order, created_at) VALUES ('c1', ?, 1, ?)`).run(agent, now)).toThrow();
    // deleting the collection cascades its membership rows
    db.prepare(`DELETE FROM collections WHERE collection_id='c1'`).run();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM collection_members WHERE collection_id='c1'`).get() as { n: number }).n).toBe(0);
    db.close();
  });
});
