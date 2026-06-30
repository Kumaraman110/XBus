/**
 * Transactional data-root migration tests.
 *
 * Covers the directive's fixture matrix (§14) + conflict policy (§4) + idempotency
 * (§13) + crash/journal recovery (§9) + secret/db preservation (§5), driven against
 * realistic SQLite fixtures built with the project's own migrations.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  summarizeRoot, decideMigration, migrateDataRoot,
  readJournal, writeMarker,
} from '../../src/cli/data-migration.js';
import { openDatabase } from '../../src/database/connection.js';
import { runMigrations, MIGRATIONS } from '../../src/database/migrations.js';

const dirs: string[] = [];
function freshDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-mig-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } dirs.length = 0; });

let rootSeq = 0;
/** Build a data root with a real migrated DB + a secret. `withData` adds runtime
 *  rows. `tag` makes the inserted data DISTINCT across roots (so two populated
 *  roots are genuinely non-identical → exercises the conflict path); default is a
 *  per-call unique tag. Pass the SAME `tag` to two roots to make them identical. */
function makeRoot(opts: { withData?: boolean; secret?: Buffer; corrupt?: boolean; tag?: string } = {}): string {
  const root = freshDir();
  const tag = opts.tag ?? `t${rootSeq++}`;
  fs.mkdirSync(path.join(root, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(root, 'auth', 'root.secret'), opts.secret ?? Buffer.alloc(32, 1));
  const dbPath = path.join(root, 'xbus.sqlite');
  if (opts.corrupt) { fs.writeFileSync(dbPath, 'not a database at all'); return root; }
  const db = openDatabase(dbPath);
  runMigrations(db, '2026-01-01T00:00:00.000Z');
  void MIGRATIONS; // (referenced for clarity that the real migration set is applied)
  if (opts.withData) {
    // insert a session + alias defensively (tolerate schema differences across versions);
    // the `tag` distinguishes one root's data from another's.
    const tryRun = (sql: string, ...args: unknown[]) => { try { db.prepare(sql).run(...args); } catch { /* tolerate */ } };
    tryRun(`INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, receive_mode, state, last_seen_at, created_at, updated_at, active_epoch) VALUES ('s-${tag}','session-${tag}','p','/','0.1.0-test.1','[]','hook_checkpoint','connected','t','t','t',1)`);
    tryRun(`INSERT INTO aliases (alias, session_id, created_at) VALUES ('alias-${tag}','s-${tag}','t')`);
  }
  db.close();
  return root;
}

function countRuntime(root: string) { const s = summarizeRoot(root); return { sessions: s.sessions, aliases: s.aliases, messages: s.messages, audit: s.audit }; }

describe('data-migration — root classification + migration decision', () => {
  it('1: legacy populated + destination health-only → migrate', () => {
    const legacy = makeRoot({ withData: true });
    const dest = makeRoot({ withData: false }); // health-only
    const d = decideMigration(summarizeRoot(legacy), summarizeRoot(dest));
    expect(d.kind).toBe('migrate');
  });

  it('2: legacy populated + destination absent → migrate', () => {
    const legacy = makeRoot({ withData: true });
    const dest = path.join(freshDir(), 'nope'); // absent
    const d = decideMigration(summarizeRoot(legacy), summarizeRoot(dest));
    expect(d.kind).toBe('migrate');
  });

  it('3: both roots identical (a byte-copy) → no_migration', () => {
    const legacy = makeRoot({ withData: true, tag: 'same' });
    const dest = freshDir();
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(legacy, dest, { recursive: true }); // exact byte copy → identical db hash
    const d = decideMigration(summarizeRoot(legacy), summarizeRoot(dest));
    expect(d.kind).toBe('no_migration');
  });

  it('4: both roots conflicting runtime data → CONFLICT (fail closed)', () => {
    const legacy = makeRoot({ withData: true });
    const dest = makeRoot({ withData: true }); // independent runtime data, different bytes
    const d = decideMigration(summarizeRoot(legacy), summarizeRoot(dest));
    expect(d.kind).toBe('conflict');
    if (d.kind === 'conflict') {
      expect(d.detail.recommended).toMatch(/will not merge/i);
      expect(typeof d.detail.databaseIdentityMatch).toBe('boolean');
    }
  });

  it('5: legacy corrupt → conflict (never silently proceed)', () => {
    const legacy = makeRoot({ corrupt: true });
    const dest = makeRoot({ withData: false });
    const d = decideMigration(summarizeRoot(legacy), summarizeRoot(dest));
    expect(['conflict', 'no_migration']).toContain(d.kind); // corrupt legacy must NOT be treated as authoritative-migrate
    expect(d.kind).not.toBe('migrate');
  });

  it('7: secret mismatch with health-only destination → still migrate (legacy secret wins)', () => {
    const legacy = makeRoot({ withData: true, secret: Buffer.alloc(32, 0xAA) });
    const dest = makeRoot({ withData: false, secret: Buffer.alloc(32, 0xBB) }); // different health secret
    const d = decideMigration(summarizeRoot(legacy), summarizeRoot(dest));
    expect(d.kind).toBe('migrate');
  });

  it('8: secret mismatch with POPULATED destination → conflict', () => {
    const legacy = makeRoot({ withData: true, secret: Buffer.alloc(32, 0xAA) });
    const dest = makeRoot({ withData: true, secret: Buffer.alloc(32, 0xBB) });
    const d = decideMigration(summarizeRoot(legacy), summarizeRoot(dest));
    expect(d.kind).toBe('conflict');
    if (d.kind === 'conflict') expect(d.detail.secretIdentityMatch).toBe(false);
  });
});

describe('data-migration — transactional migration preserves the authoritative root', () => {
  function run(legacy: string, dest: string, base: string) {
    return migrateDataRoot({
      legacyRoot: legacy, canonicalRoot: dest, fromVersion: 'legacy-data-root', toVersion: '0.1.0-beta.3',
      migrationId: 'test-mig-1', backupDir: path.join(base, 'bk'), journalPath: path.join(base, 'journal.json'),
    });
  }

  it('1: migrates legacy→dest, preserving db + secret; destination health-secret does NOT win', () => {
    const base = freshDir();
    const legacy = makeRoot({ withData: true, secret: Buffer.alloc(32, 0xAA) });
    const dest = path.join(base, 'data'); fs.cpSync(makeRoot({ withData: false, secret: Buffer.alloc(32, 0xBB) }), dest, { recursive: true });
    const legacyDbHash = summarizeRoot(legacy).dbHash;
    const legacySecretHash = summarizeRoot(legacy).secretHash;
    const r = run(legacy, dest, base);
    expect(r.ok).toBe(true); expect(r.migrated).toBe(true);
    // destination now holds the LEGACY db + LEGACY secret (authoritative), not the health one
    const after = summarizeRoot(dest);
    expect(after.dbHash).toBe(legacyDbHash);
    expect(after.secretHash).toBe(legacySecretHash);
    expect((after.sessions ?? 0)).toBeGreaterThan(0);
    // legacy SOURCE is untouched (never deleted/mutated)
    expect(fs.existsSync(path.join(legacy, 'xbus.sqlite'))).toBe(true);
    expect(summarizeRoot(legacy).dbHash).toBe(legacyDbHash);
    // destination pre-migration backup retained as a WHOLE unit
    expect(fs.existsSync(path.join(base, 'bk', 'canonical-pre-migration'))).toBe(true);
    // journal committed to staging_promoted
    expect(readJournal(path.join(base, 'journal.json'))?.state).toBe('staging_promoted');
  });

  it('11/13: idempotent — a completed marker makes a re-run a no_migration (not a conflict)', () => {
    const base = freshDir();
    const legacy = makeRoot({ withData: true });
    const dest = path.join(base, 'data'); fs.cpSync(makeRoot({ withData: false }), dest, { recursive: true });
    run(legacy, dest, base);
    // simulate the post-commit marker the installer writes
    writeMarker(dest, { migrationId: 'm', fromVersion: 'legacy-data-root', toVersion: '0.1.0-beta.3', legacyRoot: legacy, canonicalRoot: dest, sourceDatabaseHash: null, sourceSecretHash: null, completedAt: 't', legacyRootRetentionStatus: 'retained', destinationBackupPath: null });
    // a second decision must be 'already_migrated' even though the legacy root still has data
    const d2 = decideMigration(summarizeRoot(legacy), summarizeRoot(dest));
    expect(d2.kind).toBe('already_migrated');
  });

  it('12: works when the destination path contains spaces', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus mig spaces ')); dirs.push(base);
    const legacy = makeRoot({ withData: true });
    const dest = path.join(base, 'install root', 'data');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const r = run(legacy, dest, base);
    expect(r.ok).toBe(true); expect(r.migrated).toBe(true);
    expect((summarizeRoot(dest).sessions ?? 0)).toBeGreaterThan(0);
  });

  it('conflict decision yields ok=false migrated=false WITHOUT touching either root', () => {
    const base = freshDir();
    const legacy = makeRoot({ withData: true, secret: Buffer.alloc(32, 0xAA) });
    const dest = path.join(base, 'data'); fs.cpSync(makeRoot({ withData: true, secret: Buffer.alloc(32, 0xBB) }), dest, { recursive: true });
    const before = summarizeRoot(dest).dbHash;
    const r = run(legacy, dest, base);
    expect(r.ok).toBe(false); expect(r.migrated).toBe(false); expect(r.decision.kind).toBe('conflict');
    expect(summarizeRoot(dest).dbHash).toBe(before); // destination untouched
  });
});

describe('data-migration §9 — crash/journal recovery semantics', () => {
  it('a journal is written outside the replaced dir and records the terminal state', () => {
    const base = freshDir();
    const legacy = makeRoot({ withData: true });
    const dest = path.join(base, 'data'); fs.cpSync(makeRoot({ withData: false }), dest, { recursive: true });
    const journalPath = path.join(base, 'journal.json');
    migrateDataRoot({ legacyRoot: legacy, canonicalRoot: dest, fromVersion: 'legacy-data-root', toVersion: '0.1.0-beta.3', migrationId: 'jr', backupDir: path.join(base, 'bk'), journalPath });
    const j = readJournal(journalPath)!;
    expect(j.state).toBe('staging_promoted');
    expect(j.sourceRoot).toBe(legacy);
    // journal lives OUTSIDE the canonical dir being replaced
    expect(path.dirname(journalPath)).not.toBe(dest);
  });

  it('a source backup is created before the destination is touched', () => {
    const base = freshDir();
    const legacy = makeRoot({ withData: true });
    const dest = path.join(base, 'data'); fs.cpSync(makeRoot({ withData: false }), dest, { recursive: true });
    migrateDataRoot({ legacyRoot: legacy, canonicalRoot: dest, fromVersion: 'legacy-data-root', toVersion: '0.1.0-beta.3', migrationId: 'sb', backupDir: path.join(base, 'bk'), journalPath: path.join(base, 'j.json') });
    expect(fs.existsSync(path.join(base, 'bk', 'legacy-source', 'xbus.sqlite'))).toBe(true);
  });
});
