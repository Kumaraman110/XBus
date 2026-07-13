/**
 * DB snapshot + verified atomic restore (beta.5 Phase 1; ADR 0019 D4).
 * Proves: a snapshot captures db+wal+shm with per-file digests; restore VERIFIES the
 * archive before touching the live DB (a corrupted archive aborts with no change); a
 * post-snapshot forward-migration is reversed by restore; a missing DB → null (fresh
 * install, nothing to protect).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../../src/database/connection.js';
import { runMigrations, MIGRATIONS } from '../../src/database/migrations.js';
import { snapshotDb, snapshotDbCheckpointed, checkpointMainDb, restoreDbSnapshot, verifySnapshot, readSnapshotManifest, discardSnapshot } from '../../src/cli/db-snapshot.js';
import { createHash } from 'node:crypto';

let dir: string; let dbPath: string; let backupDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-snap-'));
  dbPath = path.join(dir, 'xbus.sqlite');
  backupDir = path.join(dir, '.snap');
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

/** Apply migrations only up to maxVersion (mirrors runMigrations' record-keeping). */
function migrateTo(p: string, maxVersion: number): void {
  const db = openDatabase(p, { applyPragmas: true });
  const cs = (sql: string): string => createHash('sha256').update(sql.replace(/\s+/g, ' ').trim(), 'utf8').digest('hex');
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version > maxVersion) break;
    db.transaction(() => { db.exec(m.sql); db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)').run(m.version, m.name, cs(m.sql), '2026-01-01T00:00:00.000Z'); });
  }
  db.close();
}
function schemaVersion(p: string): number {
  const db = openDatabase(p, { readOnly: true });
  try { return (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v; } finally { db.close(); }
}

describe('db snapshot + restore', () => {
  it('a missing DB → snapshot returns null (fresh install: nothing to protect)', () => {
    expect(snapshotDb(dbPath, backupDir, 0)).toBeNull();
  });

  it('snapshots db (+ sidecars), and verify passes on the archive', () => {
    migrateTo(dbPath, 6);
    const m = snapshotDb(dbPath, backupDir, 1000)!;
    expect(m).not.toBeNull();
    expect(m.files.some((f) => f.suffix === '')).toBe(true); // main DB captured
    expect(verifySnapshot(backupDir, m).ok).toBe(true);
    expect(readSnapshotManifest(backupDir)).not.toBeNull();
  });

  it('restore reverses a post-snapshot forward migration (6 → 7 → restored 6)', () => {
    migrateTo(dbPath, 6);
    expect(schemaVersion(dbPath)).toBe(6);
    snapshotDb(dbPath, backupDir, 1000);
    // Now forward-migrate the live DB to the full current schema (>=7).
    const db = openDatabase(dbPath, { applyPragmas: true });
    runMigrations(db, '2026-02-01T00:00:00.000Z');
    db.close();
    expect(schemaVersion(dbPath)).toBeGreaterThan(6);
    // Restore → back to 6, and the ledger_events table (added at 7) is gone.
    const r = restoreDbSnapshot(backupDir);
    expect(r.ok).toBe(true);
    expect(schemaVersion(dbPath)).toBe(6);
    const ro = openDatabase(dbPath, { readOnly: true });
    try {
      const t = ro.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_events'`).get();
      expect(t).toBeUndefined(); // the v7 table is absent after restore-to-6
    } finally { ro.close(); }
  });

  it('a CORRUPTED archive aborts restore with NO change to the live DB (verify-first)', () => {
    migrateTo(dbPath, 6);
    snapshotDb(dbPath, backupDir, 1000);
    // Corrupt the archived main DB file (simulate bit-rot in the backup).
    const archived = path.join(backupDir, path.basename(dbPath));
    fs.appendFileSync(archived, Buffer.from([0, 1, 2, 3]));
    // Forward-migrate the live DB, then attempt a restore from the corrupt archive.
    const db = openDatabase(dbPath, { applyPragmas: true });
    runMigrations(db, '2026-02-01T00:00:00.000Z');
    db.close();
    const before = schemaVersion(dbPath);
    const r = restoreDbSnapshot(backupDir);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/verify failed|digest mismatch/);
    // Live DB UNCHANGED (still forward-migrated) — a corrupt backup was NOT applied.
    expect(schemaVersion(dbPath)).toBe(before);
  });

  it('discardSnapshot removes the backup dir (post-successful-upgrade)', () => {
    migrateTo(dbPath, 6);
    snapshotDb(dbPath, backupDir, 1000);
    expect(fs.existsSync(backupDir)).toBe(true);
    discardSnapshot(backupDir);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  // ── Beta.5 blocker #4: checkpointed (truthful-durability) snapshot + main-DB restore ────
  it('checkpointMainDb folds WAL into the main DB; the checkpointed snapshot restores from the main DB alone', () => {
    migrateTo(dbPath, 6);
    // Write rows so there are committed WAL frames, then checkpoint.
    const w = openDatabase(dbPath, { applyPragmas: true });
    w.exec("INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, state, last_seen_at, created_at, updated_at) VALUES ('s1','session-s1','p','/','v','[]','connected','t','t','t')");
    w.close();
    const cp = checkpointMainDb(dbPath);
    expect(cp.ok).toBe(true);
    const m = snapshotDbCheckpointed(dbPath, backupDir, 1000)!;
    expect(m.files.some((f) => f.suffix === '')).toBe(true);
    expect(verifySnapshot(backupDir, m).ok).toBe(true);

    // Forward-migrate (adds v7 rows/tables + a fresh WAL), then restore from the checkpointed snapshot.
    const db = openDatabase(dbPath, { applyPragmas: true }); runMigrations(db, '2026-02-01T00:00:00.000Z'); db.close();
    expect(schemaVersion(dbPath)).toBeGreaterThan(6);
    const r = restoreDbSnapshot(backupDir);
    expect(r.ok).toBe(true);
    // Immediately after restore (before any reopen), the discarded post-migration -wal/-shm
    // are gone — the restore did not leave a stale WAL to replay over the older main DB.
    expect(fs.existsSync(dbPath + '-wal')).toBe(false);
    expect(fs.existsSync(dbPath + '-shm')).toBe(false);
    // Restored to 6: the v7 ledger_events table is gone, and the seeded row is present — proving
    // the restore used the self-contained main DB (sidecars rebuilt by SQLite on this open).
    const ro = openDatabase(dbPath, { readOnly: true });
    try {
      expect(schemaVersion(dbPath)).toBe(6);
      expect(ro.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_events'`).get()).toBeUndefined();
      expect((ro.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id='s1'").get() as { n: number }).n).toBe(1);
    } finally { ro.close(); }
  });

  it('restore reopens cleanly + is writable again after restore (sidecars rebuilt)', () => {
    migrateTo(dbPath, 6);
    snapshotDbCheckpointed(dbPath, backupDir, 1000);
    const db = openDatabase(dbPath, { applyPragmas: true }); runMigrations(db, '2026-02-01T00:00:00.000Z'); db.close();
    expect(restoreDbSnapshot(backupDir).ok).toBe(true);
    // The restored DB opens read-write + accepts a write (SQLite rebuilds -wal/-shm on open).
    const rw = openDatabase(dbPath, { applyPragmas: true });
    expect(() => rw.exec("INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, state, last_seen_at, created_at, updated_at) VALUES ('s2','session-s2','p','/','v','[]','connected','t','t','t')")).not.toThrow();
    rw.close();
  });
});
