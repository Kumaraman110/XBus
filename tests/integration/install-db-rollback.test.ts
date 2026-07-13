/**
 * Beta.5 blocker #4: whole-install DB rollback with fault injection after EVERY
 * post-migration boundary. Seeds a pre-existing s6 DB, then installs with a forced fault at
 * each stage (after-health / after-userscope / after-manifest / after-marker) and proves the
 * DB is RESTORED to s6 (never left forward-migrated at s7) before plugin/config rollback.
 *
 * Requires dist/ (suite pretest builds it). Uses the install() module directly (isolated
 * install root + data dir; never the real ~/.claude).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { install } from '../../src/cli/install.js';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { MIGRATIONS } from '../../src/database/migrations.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let root: string; let dataDir: string; let dbPath: string; let prevLegacy: string | undefined;

/** Apply migrations up to maxVersion (records them like runMigrations). */
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
  const db: SqliteDriver = openDatabase(p, { readOnly: true });
  try { return (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v; } finally { db.close(); }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-dbrb-'));
  dataDir = path.join(root, 'data');
  dbPath = path.join(dataDir, 'xbus.sqlite');
  fs.mkdirSync(dataDir, { recursive: true });
  // Seed a pre-existing s6 DB (the "upgrading from beta.4.1" case) + a sentinel row.
  migrateTo(dbPath, 6);
  const w = openDatabase(dbPath, { applyPragmas: true });
  w.exec("INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, state, last_seen_at, created_at, updated_at) VALUES ('pre-existing','session-pre','p','/','0.1.0-beta.4.1','[]','connected','t','t','t')");
  w.close();
  prevLegacy = process.env.XBUS_LEGACY_DATA_DIR;
  process.env.XBUS_LEGACY_DATA_DIR = path.join(root, 'isolated-legacy'); // no migration path
});
afterEach(() => {
  if (prevLegacy === undefined) delete process.env.XBUS_LEGACY_DATA_DIR; else process.env.XBUS_LEGACY_DATA_DIR = prevLegacy;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

const baseOpts = () => ({
  source: REPO,
  installRoot: root,
  dataDir,
  registerUserScope: true,
  claudeConfigPath: path.join(root, '.claude.json'),
  claudeSettingsPath: path.join(root, '.claude', 'settings.json'),
  stopRunningBroker: false, // no broker was started in this hermetic test
});

describe('install DB rollback — fault injection after every post-migration boundary', () => {
  for (const stage of ['after-health', 'after-userscope', 'after-manifest', 'after-marker'] as const) {
    it(`fault ${stage}: DB is RESTORED to s6 (not left at s7) + plugin rolled back`, async () => {
      // Sanity: the seeded DB is s6 before install.
      expect(schemaVersion(dbPath)).toBe(6);
      const r = await install({ ...baseOpts(), faultAfter: stage });
      expect(r.ok).toBe(false);
      expect(r.rolledBack).toBe(true);
      // THE KEY INVARIANT: the health check migrated the live DB to s7, but the failure at
      // this boundary must have RESTORED it to s6 (the pre-upgrade snapshot), never left it
      // forward-migrated with a rolled-back plugin.
      expect(schemaVersion(dbPath), `DB should be restored to s6 after ${stage}`).toBe(6);
      // The sentinel row survives (restore brought back the pre-upgrade main DB).
      const ro = openDatabase(dbPath, { readOnly: true });
      try {
        expect((ro.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id='pre-existing'").get() as { n: number }).n).toBe(1);
        // The v7 ledger_events table is gone (we're back at s6).
        expect(ro.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_events'`).get()).toBeUndefined();
      } finally { ro.close(); }
      // The error mentions the DB was restored.
      expect(r.error ?? '').toMatch(/db restored to pre-upgrade snapshot/);
      // Plugin dir was rolled back (a fresh install with no prior plugin → removed).
      expect(fs.existsSync(path.join(root, 'plugin'))).toBe(false);
    }, 60_000);
  }

  it('a CLEAN install (no fault) forward-migrates to the current schema + discards the snapshot', async () => {
    const r = await install(baseOpts());
    expect(r.ok, r.error).toBe(true);
    expect(schemaVersion(dbPath)).toBeGreaterThanOrEqual(7); // upgrade committed
    // No snapshot dir left behind on success.
    const leftover = fs.readdirSync(root).filter((n) => n.startsWith('.db.snapshot-'));
    expect(leftover).toHaveLength(0);
  }, 60_000);

  it('restore FAILURE: the recovery snapshot is RETAINED and its path is reported (never deleted)', async () => {
    expect(schemaVersion(dbPath)).toBe(6);
    // Force a boundary fault AND force the DB restore itself to fail. The DB is left
    // forward-migrated (we could not roll it back), but the recovery snapshot MUST survive so
    // the operator can restore manually — and its path must be surfaced in the error.
    const r = await install({ ...baseOpts(), faultAfter: 'after-manifest', faultRestore: true });
    expect(r.ok).toBe(false);
    // The error reports the restore failure + retains + names the snapshot path.
    expect(r.error ?? '', 'error must report the retained recovery snapshot path').toMatch(/db restore FAILED.*recovery snapshot RETAINED at .*\.db\.snapshot-/);
    // The snapshot dir is STILL on disk (not discarded) so recovery is possible.
    const kept = fs.readdirSync(root).filter((n) => n.startsWith('.db.snapshot-'));
    expect(kept.length, 'the recovery snapshot dir must be retained on restore failure').toBeGreaterThanOrEqual(1);
    // And it actually contains the pre-upgrade main DB archive (a usable recovery artifact).
    const snapDir = path.join(root, kept[0]!);
    const hasArchive = fs.readdirSync(snapDir).some((n) => n.includes('xbus.sqlite'));
    expect(hasArchive, 'retained snapshot contains the main-DB archive').toBe(true);
  }, 60_000);

  it('aborts the upgrade when a FOREIGN broker holds the DB (never snapshot/migrate under a writer we do not own)', async () => {
    // Write a broker state file owned by a DIFFERENT OS user (a foreign owner hash). The
    // installer's pre-migration writer-free gate (stopOwnedBrokerForUpgrade → classifyShutdown)
    // REFUSES to signal a broker it does not own, so install() must ABORT before any
    // snapshot/migrate — the seeded s6 DB must be left completely untouched.
    const { writeStateFile } = await import('../../src/broker/state-file.js');
    writeStateFile(dataDir, {
      pid: process.pid, // alive, but owned by a foreign identity hash below
      processStartedAt: '2026-01-01T00:00:00.000Z',
      brokerInstanceId: 'foreign-instance',
      buildId: 'xbus-p1-stp1-s7',
      endpoint: 'foreign-endpoint',
      ownerIdentityHash: 'ffffffffffffffff', // NOT this process's owner → classifyShutdown 'refuse'
    });
    expect(schemaVersion(dbPath)).toBe(6);
    // Default stop-broker probe (stopRunningBroker defaults to true).
    const r = await install({ ...baseOpts(), stopRunningBroker: undefined });
    expect(r.ok, 'must refuse to upgrade under a foreign live writer').toBe(false);
    expect(r.error ?? '').toMatch(/cannot upgrade while a broker is active|do not own|writer/i);
    // THE INVARIANT: the DB was never snapshotted/migrated — still s6, sentinel intact, no s7 tables.
    expect(schemaVersion(dbPath), 'DB untouched (still s6) when a foreign writer holds it').toBe(6);
    const ro = openDatabase(dbPath, { readOnly: true });
    try {
      expect((ro.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id='pre-existing'").get() as { n: number }).n).toBe(1);
      expect(ro.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_events'`).get(), 'no s7 migration happened').toBeUndefined();
    } finally { ro.close(); }
    // No snapshot was taken (abort was BEFORE snapshot).
    expect(fs.readdirSync(root).filter((n) => n.startsWith('.db.snapshot-')), 'no snapshot taken on a pre-migration abort').toHaveLength(0);
  }, 60_000);
});
