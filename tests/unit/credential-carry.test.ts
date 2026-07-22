/**
 * BETA.11 (ADR 0037) — durable-identity credential CARRY across a data-root relocation.
 *
 * The beta.9.1→beta.10 upgrade can move the data dir (~/.claude/xbus → the installed
 * <installRoot>/install/data). The runtime-DB migration only runs when decideMigration says
 * 'migrate'; a legacy root that holds ONLY the credential files (owner-secrets.json /
 * durable-names.json) with no runtime DB classifies as "empty" and is NOT migrated — stranding the
 * reclaim credentials in the old dir so a resumed session cannot reclaim even with the right name.
 *
 * carryDurableCredentials() copies those files INDEPENDENT of the migrate verdict, merging per-entry
 * and NEVER regressing a fresher canonical record. This test pins that behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { carryDurableCredentials } from '../../src/cli/data-migration.js';

let legacy: string; let canonical: string; let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-carry-'));
  legacy = path.join(root, 'legacy'); canonical = path.join(root, 'canonical');
  fs.mkdirSync(legacy, { recursive: true });
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

const read = (dir: string, file: string): Record<string, { secret?: string; durableName?: string; updatedAt: string }> =>
  JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, { secret?: string; durableName?: string; updatedAt: string }>;

describe('carryDurableCredentials — beta.11 upgrade must-carry', () => {
  it('secrets-only legacy dir (no runtime DB, no canonical): both credential files are carried', () => {
    fs.writeFileSync(path.join(legacy, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 's1', updatedAt: '2026-01-01T00:00:00.000Z' } }));
    fs.writeFileSync(path.join(legacy, 'durable-names.json'), JSON.stringify({ p1: { durableName: 'AccountLookUp', updatedAt: '2026-01-01T00:00:00.000Z' } }));
    const r = carryDurableCredentials(legacy, canonical);
    expect(r.carried.sort()).toEqual(['durable-names.json', 'owner-secrets.json']);
    expect(read(canonical, 'owner-secrets.json').k1.secret).toBe('s1');
    expect(read(canonical, 'durable-names.json').p1.durableName).toBe('AccountLookUp');
  });

  it('NEVER clobbers a NEWER canonical entry (merge by updatedAt)', () => {
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 'OLD', updatedAt: '2026-01-01T00:00:00.000Z' } }));
    fs.writeFileSync(path.join(canonical, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 'NEW', updatedAt: '2026-06-01T00:00:00.000Z' } }));
    carryDurableCredentials(legacy, canonical);
    expect(read(canonical, 'owner-secrets.json').k1.secret).toBe('NEW'); // fresher canonical preserved
  });

  it('carries a legacy entry that is NEWER than canonical, and UNIONS distinct keys', () => {
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 'LEG-NEW', updatedAt: '2026-06-02T00:00:00.000Z' }, k2: { secret: 'only-legacy', updatedAt: '2026-01-01T00:00:00.000Z' } }));
    fs.writeFileSync(path.join(canonical, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 'CAN-OLD', updatedAt: '2026-06-01T00:00:00.000Z' } }));
    carryDurableCredentials(legacy, canonical);
    const merged = read(canonical, 'owner-secrets.json');
    expect(merged.k1.secret).toBe('LEG-NEW');     // legacy newer → wins
    expect(merged.k2.secret).toBe('only-legacy'); // distinct key unioned in
  });

  it('is a NO-OP when legacy == canonical (same path) and when legacy has no credential files', () => {
    expect(carryDurableCredentials(legacy, legacy).carried).toEqual([]);
    expect(carryDurableCredentials(legacy, canonical).carried).toEqual([]); // legacy empty
    expect(fs.existsSync(path.join(canonical, 'owner-secrets.json'))).toBe(false);
  });

  it('idempotent: a second carry after the first changes nothing', () => {
    fs.writeFileSync(path.join(legacy, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 's1', updatedAt: '2026-01-01T00:00:00.000Z' } }));
    expect(carryDurableCredentials(legacy, canonical).carried).toEqual(['owner-secrets.json']);
    expect(carryDurableCredentials(legacy, canonical).carried).toEqual([]); // nothing new to carry
  });

  // ── BETA.11 Phase-3 security/robustness scrutiny of the credential carry ──

  it('EQUAL updatedAt → keep canonical (no clobber on a tie; last-installed does not win a tie)', () => {
    fs.mkdirSync(canonical, { recursive: true });
    const t = '2026-03-03T00:00:00.000Z';
    fs.writeFileSync(path.join(legacy, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 'LEG', updatedAt: t } }));
    fs.writeFileSync(path.join(canonical, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 'CAN', updatedAt: t } }));
    carryDurableCredentials(legacy, canonical);
    expect(read(canonical, 'owner-secrets.json').k1.secret).toBe('CAN'); // tie → canonical wins (no regress)
  });

  it('canonical entry with NO updatedAt is authoritative (never clobbered by a timestamped legacy)', () => {
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 'LEG', updatedAt: '2030-01-01T00:00:00.000Z' } }));
    fs.writeFileSync(path.join(canonical, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 'CAN' } })); // no updatedAt
    carryDurableCredentials(legacy, canonical);
    expect(read(canonical, 'owner-secrets.json').k1.secret).toBe('CAN'); // canonical without ts is authoritative
  });

  it('CASE-distinct anchor keys are independent (sha256 keys never collide/duplicate on case)', () => {
    // anchorKeys are opaque sha256 hex — different (project,name) casings hash to different keys, so
    // there is no case-sensitive duplicate-anchor hazard at the carry layer (it merges by exact key).
    fs.writeFileSync(path.join(legacy, 'owner-secrets.json'), JSON.stringify({
      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { secret: 's-lower', updatedAt: '2026-01-01T00:00:00.000Z' },
      AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA: { secret: 's-upper', updatedAt: '2026-01-01T00:00:00.000Z' },
    }));
    carryDurableCredentials(legacy, canonical);
    const m = read(canonical, 'owner-secrets.json');
    expect(Object.keys(m).length).toBe(2); // both preserved as distinct keys, no dedup/collision
  });

  it('carries ONLY the two known credential files — never an arbitrary sibling (no path traversal / broad copy)', () => {
    fs.writeFileSync(path.join(legacy, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 's1', updatedAt: '2026-01-01T00:00:00.000Z' } }));
    fs.writeFileSync(path.join(legacy, 'xbus.sqlite'), 'DBBYTES');            // must NOT be carried by this fn
    fs.writeFileSync(path.join(legacy, 'root.secret'), 'ROOTSECRET');          // must NOT be carried by this fn
    fs.writeFileSync(path.join(legacy, 'evil.json'), JSON.stringify({ x: 1 })); // arbitrary sibling
    const r = carryDurableCredentials(legacy, canonical);
    expect(r.carried).toEqual(['owner-secrets.json']); // only the credential file present was carried
    expect(fs.existsSync(path.join(canonical, 'xbus.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(canonical, 'root.secret'))).toBe(false);
    expect(fs.existsSync(path.join(canonical, 'evil.json'))).toBe(false);
  });

  it('malformed legacy JSON is a safe no-op (never throws, never writes a corrupt canonical)', () => {
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'owner-secrets.json'), '{ this is not json ');
    fs.writeFileSync(path.join(canonical, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 'CAN', updatedAt: '2026-01-01T00:00:00.000Z' } }));
    expect(() => carryDurableCredentials(legacy, canonical)).not.toThrow();
    expect(read(canonical, 'owner-secrets.json').k1.secret).toBe('CAN'); // canonical untouched
  });

  it('writes credential files with 0600 perms where the OS supports it (no broad ACL)', function () {
    if (process.platform === 'win32') return; // POSIX-mode assertion only; Windows uses dir ACL
    fs.writeFileSync(path.join(legacy, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 's1', updatedAt: '2026-01-01T00:00:00.000Z' } }));
    carryDurableCredentials(legacy, canonical);
    const mode = fs.statSync(path.join(canonical, 'owner-secrets.json')).mode & 0o777;
    expect(mode & 0o077).toBe(0); // no group/other access
  });

  it('no partial state: the canonical file is only ever the pre- or post-merge JSON (atomic rename)', () => {
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'owner-secrets.json'), JSON.stringify({ k0: { secret: 'pre', updatedAt: '2026-01-01T00:00:00.000Z' } }));
    fs.writeFileSync(path.join(legacy, 'owner-secrets.json'), JSON.stringify({ k1: { secret: 'new', updatedAt: '2026-02-01T00:00:00.000Z' } }));
    carryDurableCredentials(legacy, canonical);
    const m = read(canonical, 'owner-secrets.json');
    // Result is valid JSON with BOTH the pre-existing and the carried entry (union), never a truncated file.
    expect(m.k0.secret).toBe('pre'); expect(m.k1.secret).toBe('new');
    // No leftover temp file.
    expect(fs.readdirSync(canonical).some((f) => f.includes('.tmp'))).toBe(false);
  });
});
