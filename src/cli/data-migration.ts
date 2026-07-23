/**
 * Transactional data-root migration.
 *
 * An earlier build ran its broker on the LEGACY root `~/.claude/xbus`. A later
 * build made `<installRoot>/data` the CANONICAL root for fresh installs but
 * provided NO migration, so upgrading an existing legacy install would orphan the
 * authoritative legacy runtime data. This module migrates the legacy authoritative
 * root into the canonical destination, transactionally, with a journal, backups,
 * integrity verification, fail-closed conflict handling, crash recovery, and rollback.
 *
 * SAFETY INVARIANTS:
 *  - never delete the legacy source root during the initial upgrade;
 *  - never delete the destination pre-migration backup;
 *  - never auto-merge two SQLite databases;
 *  - never pick "newest" automatically;
 *  - never initialize a fresh empty database when authoritative data exists;
 *  - never run with two active authoritative roots;
 *  - the authoritative ROOT SECRET is preserved (the destination health-only
 *    secret must NOT replace it) — promotion moves the whole authoritative root as
 *    a unit, never mixes individual files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { assertNotReparse } from '../ipc/acl.js';
import { secretPath } from '../ipc/root-secret.js';

// Load node:sqlite via createRequire so bundlers (Vite/Vitest) don't try to
// transform the built-in module (same pattern as src/database/connection.ts).
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/** Typed classification of a data root (§3). */
export type RootClass =
  | 'absent'
  | 'empty'
  | 'health_only'
  | 'runtime_authoritative'
  | 'runtime_non_authoritative'
  | 'identical_copy'
  | 'conflicting_runtime_data'
  | 'corrupt'
  | 'incomplete_migration'
  | 'completed_migration';

export interface RootSummary {
  root: string;
  exists: boolean;
  hasDb: boolean;
  dbBytes: number;
  dbHash: string | null;        // sha256 of the sqlite file bytes (identity, not content)
  integrityOk: boolean | null;  // PRAGMA integrity_check == 'ok'
  schemaVersion: number | null;
  sessions: number | null;
  messages: number | null;
  aliases: number | null;
  audit: number | null;
  hasSecret: boolean;
  secretHash: string | null;    // NON-secret identity hash (sha256 of the secret bytes); never the secret
  hasBrokerState: boolean;
  hasMigrationMarker: boolean;
}

export const MIGRATION_MARKER = '.xbus-migration.json';
export const MIGRATION_JOURNAL = '.xbus-migration-journal.json';

function sha256File(p: string): string | null {
  try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

/** Inspect a SQLite db safely (read-only; tolerant of WAL). Returns null fields on
 *  any failure rather than throwing, so classification never crashes. */
function inspectDb(dbPath: string): { integrityOk: boolean | null; schemaVersion: number | null; sessions: number | null; messages: number | null; aliases: number | null; audit: number | null } {
  const out = { integrityOk: null as boolean | null, schemaVersion: null as number | null, sessions: null as number | null, messages: null as number | null, aliases: null as number | null, audit: null as number | null };
  if (!fs.existsSync(dbPath)) return out;
  let db: InstanceType<typeof DatabaseSync> | null = null;
  try {
    db = new DatabaseSync(dbPath); // read-write open tolerates WAL replay
    try { const r = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }; out.integrityOk = r?.integrity_check === 'ok'; } catch { out.integrityOk = false; }
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
    const count = (t: string): number | null => { if (!tables.has(t)) return null; try { return (db!.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c; } catch { return null; } };
    if (tables.has('schema_migrations')) { try { out.schemaVersion = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v; } catch { /* ignore */ } }
    out.sessions = count('sessions'); out.messages = count('messages'); out.aliases = count('aliases'); out.audit = count('audit_events');
  } catch { out.integrityOk = out.integrityOk ?? false; }
  finally { try { db?.close(); } catch { /* ignore */ } }
  return out;
}

/** Summarize a data root WITHOUT exposing the raw secret. */
export function summarizeRoot(root: string): RootSummary {
  const dbPath = path.join(root, 'xbus.sqlite');
  const secPath = secretPath(root);
  const exists = fs.existsSync(root);
  const hasDb = fs.existsSync(dbPath);
  const insp = hasDb ? inspectDb(dbPath) : { integrityOk: null, schemaVersion: null, sessions: null, messages: null, aliases: null, audit: null };
  const secretBytes = (() => { try { return fs.readFileSync(secPath); } catch { return null; } })();
  return {
    root, exists, hasDb,
    dbBytes: hasDb ? (fs.statSync(dbPath).size) : 0,
    dbHash: hasDb ? sha256File(dbPath) : null,
    integrityOk: insp.integrityOk, schemaVersion: insp.schemaVersion,
    sessions: insp.sessions, messages: insp.messages, aliases: insp.aliases, audit: insp.audit,
    hasSecret: secretBytes !== null,
    secretHash: secretBytes ? createHash('sha256').update(secretBytes).digest('hex') : null,
    hasBrokerState: fs.existsSync(path.join(root, 'broker.state.json')),
    hasMigrationMarker: fs.existsSync(path.join(root, MIGRATION_MARKER)),
  };
}

/** Does a root hold real runtime USER data (vs. an install health-check db)? A
 *  health-only db has the schema but no sessions/messages/aliases/audit rows. */
function hasRuntimeData(s: RootSummary): boolean {
  return (s.sessions ?? 0) > 0 || (s.messages ?? 0) > 0 || (s.aliases ?? 0) > 0 || (s.audit ?? 0) > 0;
}

/** Classify a root given its own summary + the OTHER root's summary (for
 *  identical/conflicting determinations). */
export function classifyRoot(self: RootSummary, other: RootSummary): RootClass {
  if (self.hasMigrationMarker) return 'completed_migration';
  if (!self.exists) return 'absent';
  if (!self.hasDb) return self.hasSecret ? 'incomplete_migration' : 'empty';
  if (self.integrityOk === false) return 'corrupt';
  // identical (same db bytes) — a safe duplicate
  if (self.dbHash && other.dbHash && self.dbHash === other.dbHash) return 'identical_copy';
  if (!hasRuntimeData(self)) return 'health_only';
  // self has runtime data. Conflicting iff the OTHER root ALSO has non-identical runtime data.
  if (other.hasDb && other.integrityOk !== false && hasRuntimeData(other) && self.dbHash !== other.dbHash) {
    return 'conflicting_runtime_data';
  }
  return 'runtime_authoritative';
}

export type MigrationDecision =
  | { kind: 'no_migration'; reason: string }
  | { kind: 'migrate'; reason: string }
  | { kind: 'already_migrated'; reason: string }
  | { kind: 'conflict'; reason: string; detail: ConflictDetail };

export interface ConflictDetail {
  legacyRoot: string;
  canonicalRoot: string;
  legacyCounts: { sessions: number | null; messages: number | null; aliases: number | null; audit: number | null };
  canonicalCounts: { sessions: number | null; messages: number | null; aliases: number | null; audit: number | null };
  secretIdentityMatch: boolean;
  databaseIdentityMatch: boolean;
  recommended: string;
}

/**
 * Decide the migration action for (legacyRoot → canonicalRoot). Pure: takes
 * summaries, returns a typed decision. Fail-closed on conflict (§4).
 */
export function decideMigration(legacy: RootSummary, canonical: RootSummary): MigrationDecision {
  const lc = classifyRoot(legacy, canonical);
  const cc = classifyRoot(canonical, legacy);

  // Already migrated: the canonical root carries the completion marker.
  if (canonical.hasMigrationMarker) return { kind: 'already_migrated', reason: 'canonical root has a completed-migration marker' };

  // Nothing to migrate from.
  if (lc === 'absent' || lc === 'empty') return { kind: 'no_migration', reason: `legacy root is ${lc}` };
  if (lc === 'health_only') return { kind: 'no_migration', reason: 'legacy root has no runtime user data (health-only)' };
  if (lc === 'identical_copy') return { kind: 'no_migration', reason: 'legacy and canonical roots are byte-identical; canonical already holds the data' };
  if (lc === 'corrupt') return { kind: 'conflict', reason: 'legacy authoritative database failed integrity_check', detail: conflictDetail(legacy, canonical) };

  // Legacy has authoritative runtime data. Safe to migrate iff canonical is
  // absent/empty/health_only.
  if (lc === 'runtime_authoritative') {
    if (cc === 'absent' || cc === 'empty' || cc === 'health_only') return { kind: 'migrate', reason: `legacy is runtime_authoritative; canonical is ${cc}` };
    if (cc === 'identical_copy') return { kind: 'no_migration', reason: 'canonical already holds an identical copy' };
    // canonical ALSO has non-identical runtime data -> conflict, fail closed.
    return { kind: 'conflict', reason: 'both roots contain non-identical runtime user data', detail: conflictDetail(legacy, canonical) };
  }
  if (lc === 'conflicting_runtime_data') return { kind: 'conflict', reason: 'both roots contain non-identical runtime user data', detail: conflictDetail(legacy, canonical) };
  return { kind: 'no_migration', reason: `legacy classified ${lc}` };
}

function conflictDetail(legacy: RootSummary, canonical: RootSummary): ConflictDetail {
  return {
    legacyRoot: legacy.root,
    canonicalRoot: canonical.root,
    legacyCounts: { sessions: legacy.sessions, messages: legacy.messages, aliases: legacy.aliases, audit: legacy.audit },
    canonicalCounts: { sessions: canonical.sessions, messages: canonical.messages, aliases: canonical.aliases, audit: canonical.audit },
    secretIdentityMatch: !!legacy.secretHash && legacy.secretHash === canonical.secretHash,
    databaseIdentityMatch: !!legacy.dbHash && legacy.dbHash === canonical.dbHash,
    recommended: 'resolve manually: keep one authoritative root (back up the other), or set XBUS_DATA_DIR explicitly; see docs/data-migration.md. XBus will not merge databases or pick automatically.',
  };
}

// ─────────────────────────── transactional migration ───────────────────────────

export type JournalState =
  | 'planned' | 'backups_created' | 'source_validated' | 'destination_classified'
  | 'staging_created' | 'copy_complete' | 'copy_verified' | 'destination_backed_up'
  | 'staging_promoted' | 'runtime_installed' | 'health_verified' | 'committed'
  | 'rollback_started' | 'rolled_back' | 'failed';

export interface MigrationJournal {
  migrationId: string;
  sourceRoot: string;
  destinationRoot: string;
  fromVersion: string;
  toVersion: string;
  sourceDbHash: string | null;
  sourceSecretHash: string | null;
  destinationPreHash: string | null;
  sourceBackup: string;
  destinationBackup: string | null;
  state: JournalState;
  recovery: string;
}

/** Atomic journal write (tmp + rename) at a path OUTSIDE the dir being replaced. */
export function writeJournal(journalPath: string, j: MigrationJournal): void {
  const tmp = `${journalPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, journalPath);
}

export function readJournal(journalPath: string): MigrationJournal | null {
  try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')) as MigrationJournal; } catch { return null; }
}

function copyDirVerified(src: string, dst: string): { files: number } {
  let files = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isSymbolicLink()) throw new Error(`refusing to copy reparse point during migration: ${s}`);
    if (ent.isDirectory()) { files += copyDirVerified(s, d).files; }
    else {
      fs.copyFileSync(s, d);
      const sh = createHash('sha256').update(fs.readFileSync(s)).digest('hex');
      const dh = createHash('sha256').update(fs.readFileSync(d)).digest('hex');
      if (sh !== dh) throw new Error(`copy checksum mismatch: ${ent.name}`);
      files++;
    }
  }
  return { files };
}

export interface MigrateOptions {
  legacyRoot: string;
  canonicalRoot: string;
  fromVersion: string;
  toVersion: string;
  migrationId: string;             // injected (deterministic in tests)
  backupDir: string;               // where to put backups (OUTSIDE both roots)
  journalPath: string;             // OUTSIDE the dir being replaced
  dryRun?: boolean;
}

export interface MigrateResult {
  ok: boolean;
  migrated: boolean;
  decision: MigrationDecision;
  finalState?: JournalState;
  error?: string;
  journal?: MigrationJournal;
}

/**
 * Perform the transactional migration (§7). Caller MUST ensure the broker is
 * stopped first. Steps are journaled at each durable transition; on failure the
 * destination is restored from its pre-migration backup and the journal records
 * the rollback. The LEGACY SOURCE is never deleted or mutated.
 */
export function migrateDataRoot(opts: MigrateOptions): MigrateResult {
  const legacy = summarizeRoot(opts.legacyRoot);
  const canonical = summarizeRoot(opts.canonicalRoot);
  const decision = decideMigration(legacy, canonical);

  if (decision.kind !== 'migrate') {
    return { ok: decision.kind !== 'conflict', migrated: false, decision };
  }
  if (opts.dryRun) return { ok: true, migrated: false, decision };

  const j: MigrationJournal = {
    migrationId: opts.migrationId,
    sourceRoot: opts.legacyRoot, destinationRoot: opts.canonicalRoot,
    fromVersion: opts.fromVersion, toVersion: opts.toVersion,
    sourceDbHash: legacy.dbHash, sourceSecretHash: legacy.secretHash,
    destinationPreHash: canonical.dbHash,
    sourceBackup: path.join(opts.backupDir, 'legacy-source'),
    destinationBackup: null,
    state: 'planned', recovery: 'resume or rollback from journal',
  };
  fs.mkdirSync(opts.backupDir, { recursive: true });
  writeJournal(opts.journalPath, j);

  const staging = path.join(path.dirname(opts.canonicalRoot), `.xbus-data.staging-${opts.migrationId}`);
  try {
    // 1) backups (legacy source — read-only copy; never mutate the source).
    copyDirVerified(opts.legacyRoot, j.sourceBackup);
    j.state = 'backups_created'; writeJournal(opts.journalPath, j);

    // 2) validate source integrity.
    const reSrc = summarizeRoot(opts.legacyRoot);
    if (reSrc.integrityOk === false) throw new Error('source integrity_check failed at migration time');
    j.state = 'source_validated'; writeJournal(opts.journalPath, j);

    // 3) classification recorded.
    j.state = 'destination_classified'; writeJournal(opts.journalPath, j);

    // 4) staging in the destination parent (same volume → atomic promote).
    fs.rmSync(staging, { recursive: true, force: true });
    try { assertNotReparse(path.dirname(opts.canonicalRoot)); } catch { /* parent may not be hardened yet */ }
    j.state = 'staging_created'; writeJournal(opts.journalPath, j);

    // 5) copy authoritative root → staging, verified.
    copyDirVerified(opts.legacyRoot, staging);
    j.state = 'copy_complete'; writeJournal(opts.journalPath, j);

    // 6) verify staged db + secret identity.
    const staged = summarizeRoot(staging);
    if (staged.dbHash !== legacy.dbHash) throw new Error('staged db hash != source db hash');
    if (staged.secretHash !== legacy.secretHash) throw new Error('staged secret hash != source secret hash');
    if (staged.integrityOk === false) throw new Error('staged db failed integrity_check');
    j.state = 'copy_verified'; writeJournal(opts.journalPath, j);

    // 7) move the EXISTING destination aside as a whole unit (never mix files —
    //    its health-only secret must not contaminate the authoritative root).
    if (fs.existsSync(opts.canonicalRoot)) {
      const destBackup = path.join(opts.backupDir, 'canonical-pre-migration');
      fs.renameSync(opts.canonicalRoot, destBackup);
      j.destinationBackup = destBackup;
    }
    j.state = 'destination_backed_up'; writeJournal(opts.journalPath, j);

    // 8) atomic promote staging → canonical (same-volume rename).
    fs.renameSync(staging, opts.canonicalRoot);
    j.state = 'staging_promoted'; writeJournal(opts.journalPath, j);

    return { ok: true, migrated: true, decision, finalState: 'staging_promoted', journal: j };
  } catch (e) {
    // rollback: remove a partial canonical, restore the destination backup.
    j.state = 'rollback_started'; try { writeJournal(opts.journalPath, j); } catch { /* ignore */ }
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    try {
      if (j.destinationBackup && fs.existsSync(j.destinationBackup) && !fs.existsSync(opts.canonicalRoot)) {
        fs.renameSync(j.destinationBackup, opts.canonicalRoot);
      }
      j.state = 'rolled_back'; writeJournal(opts.journalPath, j);
    } catch { j.state = 'failed'; try { writeJournal(opts.journalPath, j); } catch { /* ignore */ } }
    return { ok: false, migrated: false, decision, finalState: j.state, error: (e as Error).message, journal: j };
  }
}

/**
 * BETA.11 (ADR 0037): CARRY the durable-identity CREDENTIAL FILES from a legacy data root into the
 * canonical one, INDEPENDENT of the runtime-DB migrate decision.
 *
 * decideMigration keys "should we migrate" on the presence of an authoritative runtime DB
 * (classifyRoot). But `owner-secrets.json` (the reclaim credentials) and `durable-names.json` (the
 * beta.11 name-recovery index) are durable-identity data that matter EVEN when the legacy root has
 * no runtime DB (a secrets-only legacy dir classifies as "empty" → no migration → the credentials
 * were stranded, so a resume could not reclaim even with the right name). This carries them anyway.
 *
 * MERGE semantics (never regress a fresher canonical record):
 *   - per (anchorKey) entry, keep whichever side has the newer `updatedAt`;
 *   - a canonical entry with no updatedAt is treated as authoritative (never clobbered);
 *   - the file is JSON of Record<key, {..., updatedAt}>; malformed/absent sides degrade to no-op.
 * Best-effort + idempotent: any IO/parse error leaves the canonical file untouched. Secrets are
 * only ever COPIED between the two ACL-protected roots, never logged/returned. Returns which files
 * changed (for the caller's audit/log — names only, never contents).
 */
export function carryDurableCredentials(legacyRoot: string, canonicalRoot: string): { carried: string[] } {
  const carried: string[] = [];
  if (path.resolve(legacyRoot) === path.resolve(canonicalRoot)) return { carried };
  for (const file of ['owner-secrets.json', 'durable-names.json']) {
    try {
      const src = path.join(legacyRoot, file);
      if (!fs.existsSync(src)) continue;
      const legacy = JSON.parse(fs.readFileSync(src, 'utf8')) as Record<string, { updatedAt?: string }>;
      if (!legacy || typeof legacy !== 'object') continue;
      const dst = path.join(canonicalRoot, file);
      let canonical: Record<string, { updatedAt?: string }> = {};
      try { const raw = fs.readFileSync(dst, 'utf8'); const p = JSON.parse(raw) as unknown; if (p && typeof p === 'object') canonical = p as Record<string, { updatedAt?: string }>; } catch { /* absent/malformed → start empty */ }
      let changed = false;
      for (const [key, rec] of Object.entries(legacy)) {
        const cur = canonical[key];
        // Keep canonical when it exists AND is not strictly older than the legacy record.
        const canonNewer = cur !== undefined && (cur.updatedAt === undefined || (rec.updatedAt !== undefined && cur.updatedAt >= rec.updatedAt) || rec.updatedAt === undefined);
        if (!canonNewer) { canonical[key] = rec; changed = true; }
      }
      if (changed) {
        fs.mkdirSync(canonicalRoot, { recursive: true });
        const tmp = `${dst}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(canonical), { mode: 0o600 });
        fs.renameSync(tmp, dst);
        try { fs.chmodSync(dst, 0o600); } catch { /* windows/no-chmod: dir ACL covers it */ }
        carried.push(file);
      }
    } catch { /* best-effort per file: a failure just means no carry for that file this run */ }
  }
  return { carried };
}

/** Write the durable completion marker (§12) into the canonical root after the
 *  full upgrade (runtime installed + health verified) commits. No secret stored. */
export interface MigrationMarker {
  migrationId: string;
  fromVersion: string;
  toVersion: string;
  legacyRoot: string;
  canonicalRoot: string;
  sourceDatabaseHash: string | null;
  sourceSecretHash: string | null;
  completedAt: string;
  legacyRootRetentionStatus: 'retained';
  destinationBackupPath: string | null;
}

export function writeMarker(canonicalRoot: string, m: MigrationMarker): void {
  const p = path.join(canonicalRoot, MIGRATION_MARKER);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function readMarker(canonicalRoot: string): MigrationMarker | null {
  try { return JSON.parse(fs.readFileSync(path.join(canonicalRoot, MIGRATION_MARKER), 'utf8')) as MigrationMarker; } catch { return null; }
}
