/**
 * beta.12 P0 (#315) — RED-first: migration inspection must NOT mutate the legacy source.
 *
 * DEFECT (empirically established @ 87f27a1f, cross-validated by 2 sessions): summarizeRoot→inspectDb
 * opens the source SQLite READ-WRITE (`new DatabaseSync(dbPath)`, data-migration.ts ~79). When it is
 * the sole holder of a crashed-broker source (uncheckpointed -wal, no live process), its close()
 * CHECKPOINTS the -wal into the main file → the legacy source main-hash flips and -wal→0. This fires
 * on EVERY path including dryRun:true (a supposed no-op that rewrites the source DB) and the
 * conflict-abort path. The documented invariant "the LEGACY SOURCE is never deleted or mutated"
 * (data-migration.ts ~268/~295) is therefore FALSE.
 *
 * The checkpoint is semantically preserving (no rows lost) — so this is a correctness/TRUST defect
 * (false invariant + side-effecting dryRun + mutate-before-backup), NOT data-loss. See ADR 0027.
 *
 * FIX (beta.12): inspect READ-ONLY (`{ readOnly: true }`) — proven to read all uncheckpointed-WAL
 * rows correctly WITHOUT checkpointing/mutating the source. These tests FAIL at 87f27a1f (source
 * mutated) and PASS after the read-only-inspect fix.
 *
 * HOSTED_SAFE: in-process migrate + temp SQLite, no broker/host spawn.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { summarizeRoot, migrateDataRoot } from '../../src/cli/data-migration.js';
import { openDatabase } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

const dirs: string[] = [];
function freshDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-immut-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } dirs.length = 0; });

const sha = (p: string): string | null => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const walSize = (dbp: string): number => (fs.existsSync(dbp + '-wal') ? fs.statSync(dbp + '-wal').size : 0);

/** Build a CRASHED-broker legacy root: `base` rows checkpointed into main, `walOnly` rows left in an
 *  uncheckpointed -wal, NO live holder (files snapshotted out then original closed). This is the exact
 *  state where a read-WRITE inspect would checkpoint (=mutate) the source. */
function crashedLegacy(base: number, walOnly: number): { root: string; dbPath: string; live: number } {
  const holder = freshDir();
  fs.mkdirSync(path.join(holder, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(holder, 'auth', 'root.secret'), Buffer.alloc(32, 0xAA));
  const hdb = path.join(holder, 'xbus.sqlite');
  const db = openDatabase(hdb);
  runMigrations(db, '2026-01-01T00:00:00.000Z');
  const ins = (id: string) => { try { db.prepare(`INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, receive_mode, state, last_seen_at, created_at, updated_at, active_epoch) VALUES ('${id}','a-${id}','p','/','x','[]','hook_checkpoint','connected','t','t','t',1)`).run(); } catch { /* tolerate */ } };
  for (let i = 0; i < base; i++) ins(`base-${i}`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  for (let i = 0; i < walOnly; i++) ins(`wal-${i}`);
  const live = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
  // Snapshot the live on-disk files (main + uncheckpointed -wal) into a fresh crashed root:
  const root = freshDir();
  fs.mkdirSync(path.join(root, 'auth'), { recursive: true });
  fs.copyFileSync(path.join(holder, 'auth', 'root.secret'), path.join(root, 'auth', 'root.secret'));
  const dbPath = path.join(root, 'xbus.sqlite');
  fs.copyFileSync(hdb, dbPath);
  if (fs.existsSync(hdb + '-wal')) fs.copyFileSync(hdb + '-wal', dbPath + '-wal');
  if (fs.existsSync(hdb + '-shm')) fs.copyFileSync(hdb + '-shm', dbPath + '-shm');
  db.close(); // original holder gone; `root` is a crashed source with an uncheckpointed -wal
  return { root, dbPath, live };
}

describe('#315 migration source immutability — inspection must not mutate the legacy source', () => {
  it('summarizeRoot() does NOT mutate a crashed source (main-hash + -wal unchanged) yet still counts all rows', () => {
    const { root, dbPath, live } = crashedLegacy(1, 30);
    const mainBefore = sha(dbPath); const walBefore = walSize(dbPath);
    const s = summarizeRoot(root);
    expect(s.sessions, 'summarize still sees all committed rows (incl. uncheckpointed -wal)').toBe(live);
    expect(s.integrityOk, 'integrity still ok').toBe(true);
    // RED at 87f27a1f: read-write inspect checkpoints → main-hash flips + -wal→0.
    expect(sha(dbPath), 'summarizeRoot must NOT rewrite the source main file').toBe(mainBefore);
    expect(walSize(dbPath), 'summarizeRoot must NOT truncate the source -wal').toBe(walBefore);
  });

  it('dryRun migration performs ZERO writes to the legacy source (db, -wal, secret all byte-identical)', () => {
    const base = freshDir();
    const { root, dbPath } = crashedLegacy(1, 30);
    const secretPath = path.join(root, 'auth', 'root.secret');
    const before = { main: sha(dbPath), wal: walSize(dbPath), secret: sha(secretPath) };
    const r = migrateDataRoot({
      legacyRoot: root, canonicalRoot: path.join(base, 'data'),
      fromVersion: 'legacy', toVersion: '0.1.0-beta.12', migrationId: 'immut-dry',
      backupDir: path.join(base, 'bk'), journalPath: path.join(base, 'j.json'), dryRun: true,
    });
    expect(r.migrated, 'dryRun is a no-op (no promotion)').toBe(false);
    // RED at 87f27a1f: the dryRun's summarizeRoot checkpoints the crashed source.
    expect(sha(dbPath), 'dryRun must not rewrite the source DB').toBe(before.main);
    expect(walSize(dbPath), 'dryRun must not truncate the source -wal').toBe(before.wal);
    expect(sha(secretPath), 'dryRun must not touch the source secret').toBe(before.secret);
  });

  it('repeated dryRun is idempotent on the source (second run sees identical bytes)', () => {
    const base = freshDir();
    const { root, dbPath } = crashedLegacy(1, 30);
    const run = (n: number) => migrateDataRoot({ legacyRoot: root, canonicalRoot: path.join(base, `d${n}`), fromVersion: 'l', toVersion: 'x', migrationId: `idem-${n}`, backupDir: path.join(base, `bk${n}`), journalPath: path.join(base, `j${n}.json`), dryRun: true });
    run(1);
    const afterFirst = sha(dbPath);
    run(2);
    expect(sha(dbPath), 'source bytes stable across repeated dryRun').toBe(afterFirst);
  });

  it('the source remains independently usable (openable + full row count) after a dryRun', () => {
    const base = freshDir();
    const { root, dbPath, live } = crashedLegacy(1, 30);
    migrateDataRoot({ legacyRoot: root, canonicalRoot: path.join(base, 'data'), fromVersion: 'l', toVersion: 'x', migrationId: 'usable', backupDir: path.join(base, 'bk'), journalPath: path.join(base, 'j.json'), dryRun: true });
    const db = new DatabaseSync(dbPath);
    try {
      expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(live);
      expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    } finally { db.close(); }
  });

  it('a REAL (non-dryRun) migrate of a crashed source promotes ALL rows, leaving the source unmutated', () => {
    const base = freshDir();
    const { root, dbPath, live } = crashedLegacy(1, 30);
    const dest = path.join(base, 'data');
    const before = { main: sha(dbPath), wal: walSize(dbPath) };
    const r = migrateDataRoot({ legacyRoot: root, canonicalRoot: dest, fromVersion: 'legacy', toVersion: '0.1.0-beta.12', migrationId: 'real', backupDir: path.join(base, 'bk'), journalPath: path.join(base, 'j.json') });
    expect(r.migrated, 'crashed-source migrate promotes').toBe(true);
    // Complete promote: the destination has ALL committed rows (whole-root copy captured main + -wal).
    const d = new DatabaseSync(path.join(dest, 'xbus.sqlite'));
    try { expect((d.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c, 'promoted dest retains all committed rows').toBe(live); }
    finally { d.close(); }
    // Source is byte-identical (read-only inspect never checkpointed it).
    expect(sha(dbPath), 'real migrate must not mutate the source main file').toBe(before.main);
    expect(walSize(dbPath), 'real migrate must not truncate the source -wal').toBe(before.wal);
  });

  it('a CONFLICT abort leaves the legacy source byte-identical (no inspect-side mutation)', () => {
    // Two DISTINCT populated roots → decideMigration returns a conflict (never auto-merge). The
    // conflict path still summarizes both roots; that inspection must not mutate the legacy source.
    const base = freshDir();
    const { root: legacy, dbPath: legacyDb } = crashedLegacy(1, 30);
    // canonical: a DIFFERENT populated root (distinct data → conflict, not identical_copy).
    const canon = freshDir();
    fs.mkdirSync(path.join(canon, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(canon, 'auth', 'root.secret'), Buffer.alloc(32, 0xBB));
    const cdb = openDatabase(path.join(canon, 'xbus.sqlite'));
    runMigrations(cdb, '2026-01-01T00:00:00.000Z');
    try { cdb.prepare(`INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, receive_mode, state, last_seen_at, created_at, updated_at, active_epoch) VALUES ('canon-only','a-canon','p','/','x','[]','hook_checkpoint','connected','t','t','t',1)`).run(); } catch { /* tolerate */ }
    cdb.close();
    const before = { main: sha(legacyDb), wal: walSize(legacyDb) };
    const r = migrateDataRoot({ legacyRoot: legacy, canonicalRoot: canon, fromVersion: 'l', toVersion: 'x', migrationId: 'conflict', backupDir: path.join(base, 'bk'), journalPath: path.join(base, 'j.json') });
    expect(r.migrated, 'conflict is not auto-migrated').toBe(false);
    expect(sha(legacyDb), 'conflict-path inspection must not mutate the legacy source').toBe(before.main);
    expect(walSize(legacyDb), 'conflict-path inspection must not truncate the legacy -wal').toBe(before.wal);
  });
});
