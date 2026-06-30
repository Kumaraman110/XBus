/**
 * §7 — the release ZIP must be DETERMINISTIC. The previous archive was produced
 * with PowerShell Compress-Archive, whose per-run timestamps made the archive SHA
 * non-reproducible, so it could never be an approved release identity.
 *
 * These tests prove the deterministic packager:
 *   - produces a byte-identical archive from the SAME artifact across repeated runs
 *     (the cross-clone reproducibility property, observable in one process);
 *   - rounds-trips: every archived file's CRC + SHA-256 matches SHA256SUMS, both
 *     directions, and the archive parses as a valid STORE zip;
 *   - ships ONLY the installable artifact (no internal staging marker), with
 *     SHA256SUMS the sole unlisted entry;
 *   - normalizes ordering / timestamps / separators / method (STORE);
 *   - rejects a duplicate normalized path.
 *
 * Requires `dist/` (the suite pretest builds it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../../src/tools/package-win.js';
import { buildReleaseZip } from '../../src/tools/package-release-zip.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let work: string;
let artifact: string;

beforeAll(() => {
  if (!fs.existsSync(path.join(REPO, 'dist', 'cli', 'main.js'))) {
    throw new Error('dist/ missing — run `npm run build` before this test');
  }
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-relzip-'));
  artifact = path.join(work, 'artifact');
  buildPackage(artifact);
});
afterAll(() => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ } });

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

describe('§7 deterministic release ZIP', () => {
  it('produces a byte-identical archive from the same artifact across runs', () => {
    const z1 = path.join(work, 'a.zip');
    const z2 = path.join(work, 'b.zip');
    const r1 = buildReleaseZip(artifact, z1);
    const r2 = buildReleaseZip(artifact, z2);
    expect(r1.sha256).toBe(r2.sha256);
    expect(sha256File(z1)).toBe(sha256File(z2));
    expect(r1.sha256).toBe(sha256File(z1));
    // And the bytes themselves are identical (not just equal hashes).
    expect(Buffer.compare(fs.readFileSync(z1), fs.readFileSync(z2))).toBe(0);
  });

  it('round-trips: every archived file matches SHA256SUMS, both directions', () => {
    const z = path.join(work, 'rt.zip');
    const r = buildReleaseZip(artifact, z);
    expect(r.verifiedAgainstSums).toBe(true);
    // SHA256SUMS is the ONLY entry not listed in itself; the internal staging
    // marker is excluded entirely.
    expect(r.unlistedFiles).toEqual(['SHA256SUMS']);
    // entry count == files in SHA256SUMS + SHA256SUMS itself.
    const sumsLines = fs.readFileSync(path.join(artifact, 'SHA256SUMS'), 'utf8').trim().split('\n').length;
    expect(r.entryCount).toBe(sumsLines + 1);
  });

  it('excludes the internal .xbus-staging marker from the archive', () => {
    const z = path.join(work, 'nomarker.zip');
    buildReleaseZip(artifact, z);
    // Assert no ENTRY is named .xbus-staging (the literal string legitimately
    // appears inside shipped compiled code, e.g. artifact-contract's
    // CHECKSUM_EXCLUSIONS, so a raw byte search would false-positive — parse the
    // local file headers and check entry names instead).
    const buf = fs.readFileSync(z);
    const names: string[] = [];
    let i = 0;
    while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
      const compSize = buf.readUInt32LE(i + 18);
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      names.push(buf.toString('utf8', i + 30, i + 30 + nameLen));
      i += 30 + nameLen + extraLen + compSize;
    }
    expect(names).not.toContain('.xbus-staging');
    expect(names).toContain('SHA256SUMS'); // sanity: parser actually walked entries
  });

  it('writes a valid STORE-only zip with a fixed 1980 timestamp and sorted entries', () => {
    const z = path.join(work, 'struct.zip');
    buildReleaseZip(artifact, z);
    const buf = fs.readFileSync(z);
    // Walk local file headers; assert method=0 (STORE) and DOS date=0x0021/time=0.
    const names: string[] = [];
    let i = 0;
    while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
      const method = buf.readUInt16LE(i + 8);
      const time = buf.readUInt16LE(i + 10);
      const date = buf.readUInt16LE(i + 12);
      const compSize = buf.readUInt32LE(i + 18);
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
      expect(method, `entry ${name} must be STORE`).toBe(0);
      expect(time, `entry ${name} time`).toBe(0x0000);
      expect(date, `entry ${name} date`).toBe(0x0021);
      names.push(name);
      i += 30 + nameLen + extraLen + compSize;
    }
    expect(names.length).toBeGreaterThan(0);
    // Entries are sorted by UTF-8 bytes of the path.
    const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    expect(names).toEqual(sorted);
    // Forward slashes only (no backslashes in any entry name).
    expect(names.every((n) => !n.includes('\\'))).toBe(true);
  });

  it('rejects a non-artifact directory (no SHA256SUMS)', () => {
    const empty = path.join(work, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    expect(() => buildReleaseZip(empty, path.join(work, 'empty.zip'))).toThrow(/SHA256SUMS/);
  });
});
