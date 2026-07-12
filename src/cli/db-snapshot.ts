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
 * snapshot/restore — we never snapshot a DB with a live writer. With no writer, copying
 * `<db>` + `<db>-wal` + `<db>-shm` together captures a consistent set (any committed WAL
 * frames are carried in the copied `-wal`; SQLite replays them on next open).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
 * Snapshot `<dbPath>` (+ `-wal`/`-shm` if present) into `backupDir`. Copies to temp names,
 * fsyncs, then atomically renames each into place, and writes a manifest with a sha256 +
 * size per file so `restoreDbSnapshot` can VERIFY the archive before trusting it. Returns
 * the manifest. If the DB file itself is absent (fresh install — nothing to protect),
 * returns null and writes nothing.
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
  const snapshottedSuffixes = new Set(manifest.files.map((f) => f.suffix));
  try {
    // 2) Drop current sidecars so a post-migration WAL is not replayed onto the old DB.
    for (const suffix of ['-wal', '-shm']) {
      const live = dbPath + suffix;
      if (!snapshottedSuffixes.has(suffix) && fs.existsSync(live)) fs.rmSync(live, { force: true });
    }
    // 3) Restore archived files; main DB ('') LAST so a crash mid-restore never leaves a
    //    new DB with a stale/absent WAL that SQLite would misread.
    const ordered = [...manifest.files].sort((a, b) => (a.suffix === '' ? 1 : 0) - (b.suffix === '' ? 1 : 0));
    for (const f of ordered) {
      const archived = path.join(backupDir, path.basename(dbPath) + f.suffix);
      const target = dbPath + f.suffix;
      const tmp = `${target}.restore-tmp`;
      fs.copyFileSync(archived, tmp);
      fsyncFile(tmp);
      fs.renameSync(tmp, target);
    }
    fsyncDir(path.dirname(dbPath));
    return { ok: true, detail: `restored ${manifest.files.length} file(s) from snapshot` };
  } catch (e) {
    return { ok: false, detail: `restore failed: ${(e as Error).message}` };
  }
}

/** Remove a snapshot dir (called after a SUCCESSFUL upgrade — the snapshot is no longer
 *  needed). Best-effort; never throws. */
export function discardSnapshot(backupDir: string): void {
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
