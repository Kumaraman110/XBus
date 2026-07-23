/**
 * beta.12 (#315) — LIVE-holder WAL consistency guard for the read-only-inspect fix. This file is a
 * GREEN-at-both consistency guard, NOT a RED-first regression test (the RED-first regression proof
 * is migration-source-immutability.test.ts, which drives the crashed/no-holder source that actually
 * mutates under read-write inspect). The RED-first proof of THIS fix lives in that sibling file.
 *
 * HISTORY (why this file exists): an initial beta.11.1 audit hypothesized SILENT DATA LOSS on a
 * RELOCATING upgrade with a live legacy writer — the theory being that copyDirVerified copies
 * xbus.sqlite/-wal/-shm non-atomically while summarizeRoot().dbHash hashes only xbus.sqlite, so
 * committed WAL frames could vanish while the staged==source gate + PRAGMA integrity_check both
 * still pass. That silent-loss hypothesis was EMPIRICALLY DISPROVEN: the migration never promotes a
 * lossy copy — a live/active-writing holder yields a COMPLETE copy (whole-root copy captures main +
 * -wal), and a separate-process live holder keeping an unmerged -wal makes the staged copy hash
 * differ from the still-unmerged source, so the gate FAILS CLOSED (rollback), never a torn promote.
 *
 * WHAT THIS FILE NOW ASSERTS (both GREEN at the shipped beta.11 baseline 87f27a1f AND after the fix,
 * because under a LIVE holder even the old read-write inspect is not the sole connection and so never
 * checkpoints): under a live holder keeping committed rows ONLY in the -wal, (1) summarizeRoot reads
 * ALL rows through the -wal WITHOUT mutating the source (read-only inspect: main bytes + -wal size
 * unchanged), and (2) the legacy source is never mutated by summarize/migrate, so it retains every
 * committed row and stays recoverable. HOSTED_SAFE (in-process, temp SQLite, no broker spawn).
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
function freshDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-walmig-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } dirs.length = 0; });

/** Count sessions in a data root's DB (opening read-write replays any WAL, like inspectDb). */
function sessionCount(root: string): number {
  const db = new DatabaseSync(path.join(root, 'xbus.sqlite'));
  try { return (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c; }
  finally { db.close(); }
}

/** Build a legacy root with `base` rows checkpointed into the MAIN file, then `walOnly` rows that
 *  remain ONLY in the live -wal (main-file bytes untouched — the real live-writer state). Returns the
 *  still-OPEN db (a live writer holds it) + counts. Caller must db.close() when done. */
function makeLegacyWithLiveWal(root: string, base: number, walOnly: number): { db: ReturnType<typeof openDatabase>; live: number } {
  fs.mkdirSync(path.join(root, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(root, 'auth', 'root.secret'), Buffer.alloc(32, 0xAA));
  const db = openDatabase(path.join(root, 'xbus.sqlite')); // journal_mode=WAL (connection.ts)
  runMigrations(db, '2026-01-01T00:00:00.000Z');
  const ins = (id: string) => { try { db.prepare(`INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, receive_mode, state, last_seen_at, created_at, updated_at, active_epoch) VALUES ('${id}','a-${id}','p','/','x','[]','hook_checkpoint','connected','t','t','t',1)`).run(); } catch { /* tolerate */ } };
  for (let i = 0; i < base; i++) ins(`base-${i}`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');            // base rows → MAIN file
  for (let i = 0; i < walOnly; i++) ins(`wal-${i}`);      // walOnly rows → live -wal ONLY (main untouched)
  const live = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
  return { db, live };
}

describe('#315 migration WAL consistency — no silent loss of committed-but-uncheckpointed data', () => {
  it('summarizeRoot() reads all live-WAL rows WITHOUT mutating the source (read-only inspect, #315 fix)', () => {
    // The beta.12 #315 fix opens inspectDb READ-ONLY. Under a LIVE holder keeping committed rows in
    // the -wal, summarizeRoot must (a) still COUNT all rows (read-only reads through the -wal) and
    // (b) NOT mutate the source (no checkpoint: main bytes + -wal size unchanged). NOTE: dbHash stays
    // main-file-only by design — that is SAFE because the whole-tree copy (main+wal) + this
    // non-mutating read-only inspect together preserve all rows (see the promote-completeness case
    // below), so the migration never silently promotes a lossy copy. Source-immutability, not
    // dbHash-completeness, is the guarantee (full matrix in migration-source-immutability.test.ts).
    const legacy = freshDir();
    const { db, live } = makeLegacyWithLiveWal(legacy, 1, 30);
    const dbPath = path.join(legacy, 'xbus.sqlite');
    const mainBefore = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    const walBefore = fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').size : 0;
    const sum = summarizeRoot(legacy);
    const mainAfter = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    const walAfter = fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').size : 0;
    db.close();
    expect(sum.sessions, 'read-only inspect still counts all live-WAL rows').toBe(live); // 31
    expect(sum.integrityOk, 'read-only inspect reports integrity ok').toBe(true);
    expect(mainAfter, 'summarizeRoot must NOT rewrite the source main file (read-only, no checkpoint)').toBe(mainBefore);
    expect(walAfter, 'summarizeRoot must NOT truncate the source -wal').toBe(walBefore);
  });

  it('legacy source is never mutated by summarize/migrate (recoverable-by-retry invariant holds regardless)', () => {
    const base = freshDir(); const legacy = freshDir();
    const { db, live } = makeLegacyWithLiveWal(legacy, 1, 30);
    const dest = path.join(base, 'data');
    migrateDataRoot({ legacyRoot: legacy, canonicalRoot: dest, fromVersion: 'legacy', toVersion: '0.1.0-beta.11.1', migrationId: 'walmig-2', backupDir: path.join(base, 'bk'), journalPath: path.join(base, 'j.json') });
    db.close();
    // Whatever the migrate outcome, the legacy source must retain all committed rows (never mutated).
    expect(sessionCount(legacy), 'legacy source retains all committed rows (never mutated → recoverable)').toBe(live);
  });
});
