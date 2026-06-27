/**
 * §8 — clean-profile lifecycle simulations. Every scenario runs against an
 * ISOLATED temp data directory (a stand-in for a fresh user profile); the real
 * `~/.claude/xbus` profile is never touched, and no PATH / registry / shell
 * profile is modified.
 *
 * Scenarios: fresh install, upgrade (forward migration), incompatible upgrade
 * (checksum drift), rollback (DB newer than code — downgrade guard), uninstall
 * (data-dir removal), offline-after-install (no broker reachable).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations, MIGRATIONS, type Migration } from '../../src/database/migrations.js';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { loadOrCreateRootSecret, secretPath } from '../../src/ipc/root-secret.js';
import { stateFilePath } from '../../src/broker/state-file.js';
import { systemClock } from '../../src/shared/clock.js';
import { createHash } from 'node:crypto';

let profile: string; // isolated temp "user profile" data dir

function freshProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-profile-'));
}
function openProfileDb(dir: string): SqliteDriver {
  return openDatabase(path.join(dir, 'xbus.sqlite'), { applyPragmas: true });
}
function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\s+/g, ' ').trim(), 'utf8').digest('hex');
}

beforeEach(() => { profile = freshProfile(); });
afterEach(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('§8 clean-profile lifecycle', () => {
  it('fresh install: a brand-new profile migrates to the current schema and is usable', () => {
    const db = openProfileDb(profile);
    const r = runMigrations(db, systemClock.nowIso());
    // All migrations applied on a clean DB.
    expect(r.appliedNow).toEqual(MIGRATIONS.map((m) => m.version));
    expect(r.currentVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    // The schema is real: a core table exists.
    const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`).get();
    expect(t).toBeTruthy();
    db.close();
  });

  it('upgrade: an existing profile at an older schema applies only the NEW migrations', () => {
    // Simulate a profile created by an OLDER build: apply only migrations 1..3.
    const older = MIGRATIONS.filter((m) => m.version <= 3);
    const db = openProfileDb(profile);
    // Hand-run the older subset the way runMigrations would have.
    db.exec(older.map((m) => m.sql).join('\n'));
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    // (migration 1 already created schema_migrations; record the older set.)
    for (const m of older) {
      try { db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)').run(m.version, m.name, checksum(m.sql), systemClock.nowIso()); } catch { /* already recorded by m1 */ }
    }
    db.close();

    // Now the CURRENT build opens the same profile: only > 3 should apply.
    const db2 = openProfileDb(profile);
    const r = runMigrations(db2, systemClock.nowIso());
    expect(r.appliedNow.every((v) => v > 3)).toBe(true);
    expect(r.appliedNow).toContain(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    expect(r.currentVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    db2.close();
  });

  it('incompatible upgrade: a tampered/altered applied migration is rejected (checksum mismatch)', () => {
    const db = openProfileDb(profile);
    runMigrations(db, systemClock.nowIso());
    // Corrupt the recorded checksum of an applied migration (simulating a build
    // whose migration text changed under the same version number).
    db.prepare(`UPDATE schema_migrations SET checksum='deadbeef' WHERE version=1`).run();
    db.close();
    const db2 = openProfileDb(profile);
    expect(() => runMigrations(db2, systemClock.nowIso())).toThrowError(/checksum mismatch/);
    db2.close();
  });

  it('rollback: an OLD build refuses a profile whose DB schema is NEWER than the code', () => {
    // Fresh profile at current schema, then a "future" migration recorded as if a
    // newer build had upgraded it.
    const db = openProfileDb(profile);
    runMigrations(db, systemClock.nowIso());
    const future = MIGRATIONS[MIGRATIONS.length - 1]!.version + 1;
    db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)').run(future, 'future_feature', 'futuresum', systemClock.nowIso());
    db.close();
    // The current (now "old relative to the DB") build must fail closed.
    const db2 = openProfileDb(profile);
    expect(() => runMigrations(db2, systemClock.nowIso())).toThrowError(/newer than this XBus build/);
    db2.close();
  });

  it('offline after install: a freshly-installed profile with no running broker reports not-reachable, not crash', async () => {
    // Installing = the data dir + secret exist, but no broker is running.
    loadOrCreateRootSecret(profile);
    expect(fs.existsSync(secretPath(profile))).toBe(true);
    // No broker has been started, so no state file exists.
    expect(fs.existsSync(stateFilePath(profile))).toBe(false);
    // Starting a broker in this clean profile succeeds (proves the offline profile
    // is a valid, startable install — not corrupt).
    const broker = await startBrokerHost({ dataDir: profile, reaperIntervalMs: 0 });
    expect(fs.existsSync(stateFilePath(profile))).toBe(true); // now reachable
    await broker.stop();
    // After a clean stop the owned state file is removed (graceful shutdown).
    expect(fs.existsSync(stateFilePath(profile))).toBe(false);
  });

  it('uninstall: removing the profile leaves no XBus state and a re-install starts clean', async () => {
    const broker = await startBrokerHost({ dataDir: profile, reaperIntervalMs: 0 });
    await broker.stop();
    expect(fs.existsSync(path.join(profile, 'xbus.sqlite'))).toBe(true);
    // Uninstall = remove the data dir.
    fs.rmSync(profile, { recursive: true, force: true });
    expect(fs.existsSync(profile)).toBe(false);
    // Re-install into the same path starts completely fresh (no leftover state).
    const broker2 = await startBrokerHost({ dataDir: profile, reaperIntervalMs: 0 });
    const sessions = broker2.db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number };
    expect(sessions.n).toBe(0); // clean slate
    await broker2.stop();
  });

  it('upgrade preserves data: a message persisted by the old schema survives the migration', () => {
    // Older-build profile (<= 3) with a row in a table that exists in both.
    const older = MIGRATIONS.filter((m) => m.version <= 3);
    const db = openProfileDb(profile);
    db.exec(older.map((m) => m.sql).join('\n'));
    for (const m of older) {
      try { db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)').run(m.version, m.name, checksum(m.sql), systemClock.nowIso()); } catch { /* m1 */ }
    }
    // Insert a session row under the old schema.
    db.prepare(`INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, receive_mode, state, last_seen_at, created_at, updated_at, active_epoch) VALUES ('s1','session-s1','p','/','0.1.0','[]','hook_checkpoint','connected',?,?,?,1)`).run(systemClock.nowIso(), systemClock.nowIso(), systemClock.nowIso());
    db.close();
    // Upgrade.
    const db2 = openProfileDb(profile);
    runMigrations(db2, systemClock.nowIso());
    // The row survives, and the new column (readiness, migration v5) has its default.
    const row = db2.prepare(`SELECT session_id, readiness FROM sessions WHERE session_id='s1'`).get() as { session_id: string; readiness: string };
    expect(row.session_id).toBe('s1');
    expect(row.readiness).toBe('initializing'); // v5 default applied to the pre-existing row
    db2.close();
  });
});
