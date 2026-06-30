/**
 * §7 — DETERMINISTIC release-ZIP packaging.
 *
 * Root cause it addresses: the release archive was produced with PowerShell
 * `Compress-Archive`, whose output embeds per-run timestamps and is therefore
 * NON-reproducible — two clean clones produced different archive SHAs, so the
 * ZIP SHA could never be an approved release identity.
 *
 * This tool reads ONLY the frozen, already-built artifact directory (the output
 * of package-win.ts) and emits a byte-reproducible ZIP. Two clean clones at the
 * same source commit, on ANY supported Node/OS, produce a BYTE-IDENTICAL archive
 * and therefore an identical SHA-256.
 *
 * Determinism strategy (every variable that a generic zipper leaves to chance is
 * pinned here):
 *   - entry ordering        sorted by UTF-8 bytes of the normalized POSIX path
 *   - entry timestamps      ONE fixed DOS timestamp (1980-01-01 00:00:00) for all
 *   - path separators       forward slashes only
 *   - directory entries     NONE — files only; extractors recreate dirs from paths
 *   - compression           STORE (method 0). Deliberate: DEFLATE output varies by
 *                           zlib version/build across Node releases, which would
 *                           re-introduce non-determinism. STORE has no level and
 *                           copies bytes verbatim, so it is identical everywhere.
 *   - file attributes       fixed (external attrs = 0; version-made-by = FAT/2.0)
 *   - dedup / symlinks      duplicate normalized paths are rejected; symlinks and
 *                           Windows reparse points are rejected (no escape, no
 *                           non-portable entry).
 *
 * Self-verification: after writing, the archive is re-parsed from disk (its OWN
 * central directory), every STORE entry is extracted, and its CRC-32 + SHA-256 are
 * checked against the artifact's SHA256SUMS — in BOTH directions (every listed file
 * present and matching; every entry accounted for). A mismatch fails closed.
 *
 * Builder environment (Node version, OS, CPU) is NON-deterministic and is written
 * to release-provenance.json ALONGSIDE the ZIP — out of band — never inside the
 * reproducible artifact or the archive.
 *
 * Pure Node built-ins only (no archiver/zip dependency): the product ships uuid +
 * zod only, and the packaging tool holds to the same no-extra-dependency bar.
 *
 * Run: `node dist/tools/package-release-zip.js <artifactDir> <outZip>`
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

/** DOS date/time for 1980-01-01 00:00:00 (the ZIP epoch). date = (year-1980)<<9 |
 *  month<<5 | day = 0<<9 | 1<<5 | 1 = 0x0021; time = 0. Fixed for EVERY entry. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
/** version needed to extract / version made by (2.0, host FAT). */
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 20; // host 0 (FAT) << 8 | 20 == 0x0014

interface ZipFileEntry {
  /** normalized POSIX relative path (the in-archive name) */
  name: string;
  /** absolute source path on disk */
  abs: string;
  data: Buffer;
  crc32: number;
  /** byte offset of this entry's local header in the archive */
  offset: number;
}

export interface ReleaseZipResult {
  zipPath: string;
  sha256: string;
  entryCount: number;
  totalBytes: number;
  /** verification: every SHA256SUMS line matched a stored entry, and vice versa */
  verifiedAgainstSums: boolean;
  /** files present in the archive but not covered by SHA256SUMS (expected: just
   *  SHA256SUMS itself — the manifest does not list itself) */
  unlistedFiles: string[];
}

/** crc32 (zlib.crc32 — Node >= 22.5, which engines requires). Returns an unsigned
 *  32-bit integer. */
function crc32(buf: Buffer): number {
  // zlib.crc32 may not be typed on older @types/node; it is present at runtime on
  // every supported Node. Guard with a clear error rather than a silent wrong sum.
  const fn = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (typeof fn !== 'function') throw new Error('zlib.crc32 unavailable — Node >= 22.5 required for deterministic packaging');
  return fn(buf) >>> 0;
}

/** Internal packaging markers that describe the STAGING dir, not the installable
 *  artifact — never shipped in a release asset. (SHA256SUMS IS shipped: it is the
 *  manifest the user verifies the extracted tree against.) */
const STAGING_ONLY_FILES = new Set(['.xbus-staging']);

/** Collect every regular file under root as a normalized POSIX relative path.
 *  Rejects symlinks / reparse points (lstat) — they are non-portable and could
 *  escape the artifact root. Skips internal staging markers. */
function collectFiles(root: string): Array<{ name: string; abs: string }> {
  const out: Array<{ name: string; abs: string }> = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) throw new Error(`refusing to package a symlink / reparse point: ${path.relative(root, abs)}`);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.isFile()) throw new Error(`refusing to package a non-regular file: ${path.relative(root, abs)}`);
      const name = path.relative(root, abs).split(path.sep).join('/');
      if (STAGING_ONLY_FILES.has(name)) continue; // internal marker — not part of the release asset
      out.push({ name, abs });
    }
  };
  walk(root);
  return out;
}

/** Build the deterministic ZIP in memory, write it, then re-verify from disk. */
export function buildReleaseZip(artifactDir: string, outZipPath: string): ReleaseZipResult {
  if (!fs.existsSync(artifactDir) || !fs.statSync(artifactDir).isDirectory()) {
    throw new Error(`artifact dir not found: ${artifactDir}`);
  }
  // The artifact must be a complete package (SHA256SUMS is the manifest we verify
  // against). Refuse to zip a half-built or arbitrary directory.
  const sumsPath = path.join(artifactDir, 'SHA256SUMS');
  if (!fs.existsSync(sumsPath)) throw new Error(`not a frozen artifact dir (no SHA256SUMS): ${artifactDir} — run package-win first`);

  const files = collectFiles(artifactDir);

  // Reject duplicate normalized paths (case-exact). On a case-insensitive FS a
  // case-only collision would also be a hazard; flag those too.
  const seen = new Map<string, string>();
  for (const f of files) {
    const lc = f.name.toLowerCase();
    const prev = seen.get(lc);
    if (prev !== undefined) throw new Error(`duplicate normalized path in artifact: "${f.name}" collides with "${prev}"`);
    seen.set(lc, f.name);
  }

  // Deterministic order: sort by UTF-8 bytes of the normalized path.
  files.sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')));

  const localChunks: Buffer[] = [];
  const entries: ZipFileEntry[] = [];
  let offset = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.abs);
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);

    // Local file header (30 bytes + name), STORE (method 0): compressed == raw.
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // signature
    lfh.writeUInt16LE(VERSION_NEEDED, 4);
    lfh.writeUInt16LE(0, 6);            // general purpose bit flag (0; ASCII names)
    lfh.writeUInt16LE(0, 8);            // method: STORE
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); // compressed size == uncompressed (STORE)
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);           // extra field length

    entries.push({ name: f.name, abs: f.abs, data, crc32: crc, offset });
    localChunks.push(lfh, nameBuf, data);
    offset += lfh.length + nameBuf.length + data.length;
  }

  // Central directory.
  const centralChunks: Buffer[] = [];
  const centralStart = offset;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);   // signature
    cdh.writeUInt16LE(VERSION_MADE_BY, 4);
    cdh.writeUInt16LE(VERSION_NEEDED, 6);
    cdh.writeUInt16LE(0, 8);            // gp bit flag
    cdh.writeUInt16LE(0, 10);           // method: STORE
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(e.crc32, 16);
    cdh.writeUInt32LE(e.data.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);           // extra field length
    cdh.writeUInt16LE(0, 32);           // file comment length
    cdh.writeUInt16LE(0, 34);           // disk number start
    cdh.writeUInt16LE(0, 36);           // internal file attributes
    cdh.writeUInt32LE(0, 38);           // external file attributes (fixed)
    cdh.writeUInt32LE(e.offset, 42);    // relative offset of local header
    centralChunks.push(cdh, nameBuf);
    offset += cdh.length + nameBuf.length;
  }
  const centralSize = offset - centralStart;

  // End of central directory record.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);    // signature
  eocd.writeUInt16LE(0, 4);             // number of this disk
  eocd.writeUInt16LE(0, 6);             // disk with start of central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);            // comment length

  const archive = Buffer.concat([...localChunks, ...centralChunks, eocd]);
  fs.mkdirSync(path.dirname(path.resolve(outZipPath)), { recursive: true });
  fs.writeFileSync(outZipPath, archive);
  const sha256 = createHash('sha256').update(archive).digest('hex');

  // Self-verification: re-parse the archive FROM DISK and cross-check every entry
  // against SHA256SUMS in both directions.
  const verification = verifyZipAgainstSums(outZipPath, sumsPath);

  return {
    zipPath: outZipPath,
    sha256,
    entryCount: entries.length,
    totalBytes: archive.length,
    verifiedAgainstSums: verification.ok,
    unlistedFiles: verification.unlisted,
  };
}

/** Minimal ZIP reader (STORE only) for round-trip self-verification: read the
 *  central directory of the archive we just wrote, extract each stored entry, and
 *  confirm CRC-32 + SHA-256 match the artifact's SHA256SUMS. */
function verifyZipAgainstSums(zipPath: string, sumsPath: string): { ok: boolean; unlisted: string[] } {
  const buf = fs.readFileSync(zipPath);
  // Locate EOCD (no comment, so it's the last 22 bytes).
  let eocdPos = buf.length - 22;
  if (eocdPos < 0 || buf.readUInt32LE(eocdPos) !== 0x06054b50) {
    // Fall back to scanning (defensive; we never write a comment).
    eocdPos = -1;
    for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; } }
    if (eocdPos < 0) throw new Error('self-verify: EOCD not found in archive');
  }
  const total = buf.readUInt16LE(eocdPos + 10);
  let cd = buf.readUInt32LE(eocdPos + 16);

  // Parse SHA256SUMS into a path -> sha map.
  const sumByPath = new Map<string, string>();
  for (const line of fs.readFileSync(sumsPath, 'utf8').split('\n')) {
    // SHA256SUMS lines are "<64-hex>  <relpath>" (two-space separator).
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) continue;
    sumByPath.set(m[2]!, m[1]!);
  }

  const seenInZip = new Set<string>();
  const unlisted: string[] = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('self-verify: bad central directory signature');
    const method = buf.readUInt16LE(cd + 10);
    const crc = buf.readUInt32LE(cd + 16);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const lho = buf.readUInt32LE(cd + 42);
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen);
    if (method !== 0) throw new Error(`self-verify: entry "${name}" is not STORE (method ${method})`);

    // Local header → data offset.
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`self-verify: bad local header for "${name}"`);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);

    if (crc32(data) !== (crc >>> 0)) throw new Error(`self-verify: CRC mismatch for "${name}"`);
    seenInZip.add(name);
    const expected = sumByPath.get(name);
    if (expected === undefined) {
      // SHA256SUMS does not list itself — it is the only acceptable unlisted entry
      // (the internal .xbus-staging marker is excluded from the archive entirely).
      if (name !== 'SHA256SUMS') {
        throw new Error(`self-verify: archived file not covered by SHA256SUMS: "${name}"`);
      }
      unlisted.push(name);
      cd += 46 + nameLen + extraLen + commentLen;
      continue;
    }
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== expected) throw new Error(`self-verify: SHA-256 mismatch for "${name}" (archive ${actual} != SHA256SUMS ${expected})`);
    cd += 46 + nameLen + extraLen + commentLen;
  }

  // Reverse direction: every SHA256SUMS line must have a matching archive entry.
  for (const listed of sumByPath.keys()) {
    if (!seenInZip.has(listed)) throw new Error(`self-verify: SHA256SUMS lists "${listed}" but it is missing from the archive`);
  }
  return { ok: true, unlisted: unlisted.sort() };
}

// CLI entry — `node dist/tools/package-release-zip.js <artifactDir> <outZip>`.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/package-release-zip.js')) {
  const artifactDir = process.argv[2];
  const outZip = process.argv[3];
  if (!artifactDir || !outZip) {
    process.stderr.write('usage: node dist/tools/package-release-zip.js <artifactDir> <outZip>\n');
    process.exit(2);
  }
  let r: ReleaseZipResult;
  try { r = buildReleaseZip(artifactDir, outZip); }
  catch (e) { process.stderr.write(`package-release-zip FAILED: ${(e as Error).message}\n`); process.exit(1); }

  // Out-of-band release provenance (builder env) — written NEXT TO the ZIP, never
  // inside the reproducible artifact. NON-deterministic by design; not part of the
  // archive identity.
  const provenanceOut = outZip.replace(/\.zip$/i, '') + '.release-provenance.json';
  fs.writeFileSync(provenanceOut, JSON.stringify({
    archive: path.basename(r.zipPath),
    archiveSha256: r.sha256,
    entryCount: r.entryCount,
    archiveBytes: r.totalBytes,
    builtWithNode: process.version,
    builtOnPlatform: `${process.platform}/${process.arch}`,
    note: 'Builder environment is recorded out-of-band; it is NOT part of the deterministic archive. Two clean clones on any supported Node produce an identical archiveSha256.',
  }, null, 2) + '\n');

  process.stdout.write(
    `Deterministic release ZIP -> ${r.zipPath}\n` +
    `  entries: ${r.entryCount}  bytes: ${r.totalBytes}\n` +
    `  archive SHA-256: ${r.sha256}\n` +
    `  SHA256SUMS round-trip: ${r.verifiedAgainstSums ? 'VERIFIED' : 'FAILED'} (unlisted: ${r.unlistedFiles.join(', ') || 'none'})\n` +
    `  release-provenance: ${path.basename(provenanceOut)}\n`,
  );
  if (!r.verifiedAgainstSums) process.exit(3);
  process.exit(0);
}
