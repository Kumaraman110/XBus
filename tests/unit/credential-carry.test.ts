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
});
