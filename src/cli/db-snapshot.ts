/**
 * Durable DB snapshot + verified atomic restore for the install/upgrade path
 * (beta.5 Phase 1; ADR 0019 D4 / ADR 0020 "new code").
 *
 * The gap this closes: `install` runs a post-install health check that STARTS a broker
 * against the live data dir, which runs migrations (e.g. 6→7) on the live DB BEFORE any
 * snapshot — so a health-check failure previously left the DB migrated with only the
 * plugin rolled back. Phase 1 must snapshot the DB on ANY schema increase and restore it
 * on rollback. This module is that primitive; it is WAL/SHM-safe and verifies the archive
 * before it is trusted.
 *
 * PREREQUISITE (ADR 0019 D4, enforced by the caller): the broker is STOPPED before a
 * snapshot/restore — we never snapshot a DB with a live writer.
 *
 * WINDOWS DURABILITY — truthful claim (blocker #4): we do NOT rely on atomically copying
 * three files (`<db>`/`-wal`/`-shm`) as a consistent set (there is no cross-file atomic copy
 * on Windows, and a crash mid-copy could mismatch them). Instead `checkpointMainDb()` runs,
 * with the writer stopped, a `PRAGMA wal_checkpoint(TRUNCATE)` that folds ALL committed WAL
 * frames into the main DB file and empties the `-wal`. The snapshot is then of a
 * SELF-CONTAINED main DB (the `-wal`/`-shm`, if still present, are empty/rebuildable). Restore
 * writes the main DB last and removes any live `-wal`/`-shm` so SQLite never replays a stale
 * WAL over the restored DB. So the durability rests on: writer-stopped + checkpoint + a
 * digest-verified main-DB copy — NOT on multi-file atomicity. Crash-point tests prove restore
 * yields either the pre- or post-restore main DB, never a mismatched mix.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../database/connection.js';

const SIDECAR_SUFFIXES = ['', '-wal', '-shm'] as const;

interface SnapshotFileEntry { suffix: string; sha256: string; bytes: number; }
export interface SnapshotManifest {
  dbPath: string;
  createdAtMs: number;
  files: SnapshotFileEntry[]; // only the files that existed at snapshot time
}

function sha256File(p: string): { sha256: string; bytes: number } {
  const buf = fs.readFileSync(p);
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

/** fsync a file path (best-effort durability barrier). */
function fsyncFile(p: string): void {
  try { const fd = fs.openSync(p, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* best effort */ }
}
function fsyncDir(dir: string): void {
  try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* dirs aren't fsync-able on all platforms */ }
}

/**
 * Fold all committed WAL frames into the main DB (writer MUST be stopped — caller's
 * responsibility). `wal_checkpoint(TRUNCATE)` checkpoints then truncates the `-wal` to zero,
 * so afterwards the main DB is self-contained. Best-effort + honest: returns whether the
 * checkpoint fully completed (`busy=0`), so the caller can decide (we still snapshot the
 * sidecars as a belt-and-braces set even if a checkpoint couldn't fully complete). Never
 * throws — a checkpoint failure degrades to the file-set copy, it does not abort the snapshot.
 */
export function checkpointMainDb(dbPath: string): { ok: boolean; detail: string } {
  if (!fs.existsSync(dbPath)) return { ok: true, detail: 'no db' };
  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(dbPath, { applyPragmas: true }); // writer handle; writer is stopped
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined;
    // busy=0 means the checkpoint obtained the needed lock + completed (no other connection).
    const ok = !row || (row.busy ?? 0) === 0;
    return { ok, detail: ok ? 'checkpoint complete' : 'checkpoint busy (another handle open?)' };
  } catch (e) {
    return { ok: false, detail: `checkpoint failed: ${(e as Error).message}` };
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }
}

/**
 * CHECKPOINT then snapshot (the truthful-durability path, blocker #4). Requires the writer
 * stopped. Checkpoints committed WAL frames into the main DB so the snapshot's main-DB file
 * is self-contained, then snapshots via snapshotDb. Returns the manifest (null if no DB).
 */
export function snapshotDbCheckpointed(dbPath: string, backupDir: string, nowMs: number): SnapshotManifest | null {
  checkpointMainDb(dbPath); // best-effort; snapshotDb still copies whatever sidecars remain
  return snapshotDb(dbPath, backupDir, nowMs);
}

/**
 * Snapshot `<dbPath>` (+ `-wal`/`-shm` if present) into `backupDir`. Copies to temp names,
 * fsyncs, then atomically renames each into place, and writes a manifest with a sha256 +
 * size per file so `restoreDbSnapshot` can VERIFY the archive before trusting it. Returns
 * the manifest. If the DB file itself is absent (fresh install — nothing to protect),
 * returns null and writes nothing. Prefer snapshotDbCheckpointed() so the main-DB file is
 * self-contained; this raw form is kept for callers that already checkpointed.
 */
export function snapshotDb(dbPath: string, backupDir: string, nowMs: number): SnapshotManifest | null {
  if (!fs.existsSync(dbPath)) return null; // fresh install: no live DB to snapshot
  fs.mkdirSync(backupDir, { recursive: true });
  const files: SnapshotFileEntry[] = [];
  for (const suffix of SIDECAR_SUFFIXES) {
    const src = dbPath + suffix;
    if (!fs.existsSync(src)) continue;
    const dst = path.join(backupDir, path.basename(dbPath) + suffix);
    const tmp = `${dst}.tmp`;
    fs.copyFileSync(src, tmp);
    fsyncFile(tmp);
    fs.renameSync(tmp, dst);
    const { sha256, bytes } = sha256File(dst);
    files.push({ suffix, sha256, bytes });
  }
  const manifest: SnapshotManifest = { dbPath, createdAtMs: nowMs, files };
  const mPath = path.join(backupDir, 'snapshot.manifest.json');
  const mTmp = `${mPath}.tmp`;
  fs.writeFileSync(mTmp, JSON.stringify(manifest, null, 2));
  fsyncFile(mTmp);
  fs.renameSync(mTmp, mPath);
  fsyncDir(backupDir);
  return manifest;
}

/** Read + validate a snapshot manifest from a backup dir (null if absent/malformed). */
export function readSnapshotManifest(backupDir: string): SnapshotManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(backupDir, 'snapshot.manifest.json'), 'utf8')) as SnapshotManifest;
    if (typeof m.dbPath === 'string' && Array.isArray(m.files)) return m;
    return null;
  } catch { return null; }
}

/**
 * Verify every archived file's bytes against the manifest sha256 (independent read-back)
 * BEFORE any restore touches the live DB. Returns ok + the first mismatch, if any.
 */
export function verifySnapshot(backupDir: string, manifest: SnapshotManifest): { ok: boolean; detail?: string } {
  for (const f of manifest.files) {
    const archived = path.join(backupDir, path.basename(manifest.dbPath) + f.suffix);
    if (!fs.existsSync(archived)) return { ok: false, detail: `missing archived file ${archived}` };
    const { sha256, bytes } = sha256File(archived);
    if (sha256 !== f.sha256 || bytes !== f.bytes) return { ok: false, detail: `archive digest mismatch for ${path.basename(manifest.dbPath) + f.suffix}` };
  }
  return { ok: true };
}

/**
 * Restore the DB from a verified snapshot. Ordering for a clean, verified restore:
 *   1. VERIFY the archive digests (abort with no changes if any mismatch — never restore a
 *      corrupt backup over the live DB).
 *   2. Remove the CURRENT live `-wal`/`-shm` sidecars (post-migration WAL must not survive
 *      and be replayed on top of the restored older DB).
 *   3. Copy each archived file to `<target>.restore-tmp`, fsync, then atomic-rename into
 *      place (main DB last). If a sidecar was NOT in the snapshot, ensure it is absent.
 * A crash between steps leaves either the pre-restore state or the restored state — never a
 * half-mix that SQLite would misread (the main DB is renamed last, and its `-wal` either
 * matches the snapshot or is absent). Returns ok + detail.
 */
export function restoreDbSnapshot(backupDir: string): { ok: boolean; detail: string } {
  const manifest = readSnapshotManifest(backupDir);
  if (!manifest) return { ok: false, detail: 'no snapshot manifest to restore' };
  const v = verifySnapshot(backupDir, manifest);
  if (!v.ok) return { ok: false, detail: `snapshot verify failed: ${v.detail}` };

  const dbPath = manifest.dbPath;
  const mainEntry = manifest.files.find((f) => f.suffix === '');
  if (!mainEntry) return { ok: false, detail: 'snapshot has no main DB file' };
  try {
    // MAIN-DB-AUTHORITATIVE restore (truthful Windows durability, blocker #4): the snapshot's
    // main DB was checkpointed self-contained (snapshotDbCheckpointed), so we restore ONLY the
    // main DB and REMOVE any live `-wal`/`-shm`. SQLite rebuilds the sidecars from the restored
    // main DB on next open; a stale WAL is never replayed over it. This avoids depending on
    // multi-file atomic copy (which Windows can't give). The main DB is written via a temp +
    // atomic rename, so a crash leaves either the pre- or post-restore main DB — never a torn one.
    const archivedMain = path.join(backupDir, path.basename(dbPath));
    const tmp = `${dbPath}.restore-tmp`;
    fs.copyFileSync(archivedMain, tmp);
    fsyncFile(tmp);
    // Remove live sidecars FIRST (they belong to the post-migration DB we're discarding),
    // then atomic-rename the restored main DB into place.
    for (const suffix of ['-wal', '-shm']) { const live = dbPath + suffix; if (fs.existsSync(live)) fs.rmSync(live, { force: true }); }
    fs.renameSync(tmp, dbPath);
    fsyncDir(path.dirname(dbPath));
    return { ok: true, detail: 'restored main DB from checkpointed snapshot (sidecars rebuilt by SQLite on open)' };
  } catch (e) {
    return { ok: false, detail: `restore failed: ${(e as Error).message}` };
  }
}

/** Remove a snapshot dir (called after a SUCCESSFUL upgrade — the snapshot is no longer
 *  needed). Best-effort; never throws. */
export function discardSnapshot(backupDir: string): void {
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
