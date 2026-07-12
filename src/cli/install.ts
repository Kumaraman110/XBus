/**
 * `xbus install` / `xbus uninstall` — user-scope, reversible, idempotent.
 *
 * Installs the XBus plugin payload (the `--plugin-dir` directory:
 * .claude-plugin/, .mcp.json, hooks/, dist/, node_modules/{uuid,zod},
 * package.json) into a user-scope install root, records an install manifest so
 * uninstall removes exactly what it created, backs up any pre-existing file
 * before overwriting, stages atomically (temp dir + rename), verifies file
 * checksums + ACLs, rejects reparse points, and runs a post-install health check
 * with automatic rollback on failure.
 *
 * It does NOT modify PATH, the registry, or a PowerShell profile (that is a
 * separate, explicitly-requested step, intentionally not performed here).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { hardenDir, hardenFile, describeAcl, assertNotReparse } from '../ipc/acl.js';
import { loadOrCreateRootSecret, secretPath } from '../ipc/root-secret.js';
import { startBrokerHost } from '../broker/host.js';
import { BUILD_ID } from '../protocol/handshake.js';
import { XBUS_VERSION } from '../protocol/version.js';
import { defaultInstallRoot, manifestPath, readInstallManifest, defaultDataDir, type InstallManifest } from '../launcher/install-paths.js';
import { validateArtifact } from '../shared/artifact-contract.js';
import { summarizeRoot, decideMigration, migrateDataRoot, writeMarker, readMarker, type MigrationDecision } from './data-migration.js';
import { registerUserScope, unregisterUserScope, defaultClaudeConfigPath, defaultClaudeSettingsPath } from './user-scope-config.js';
import { SCHEMA_VERSION } from '../protocol/handshake.js';
import { snapshotDb, restoreDbSnapshot, discardSnapshot, type SnapshotManifest } from './db-snapshot.js';
import { openDatabase } from '../database/connection.js';

/**
 * Read the on-disk DB schema version WITHOUT migrating (a plain read of MAX(version) from
 * schema_migrations). Returns 0 if the DB or table is absent. Used to decide whether the
 * post-install health check (which starts a broker and thus migrates the live DB) will
 * apply a schema INCREASE — if so, we snapshot the DB first so a health-check failure can
 * restore the pre-upgrade DB (ADR 0019 D4). Opens read-only so it never itself migrates.
 */
function onDiskSchemaVersion(dbPath: string): number {
  if (!fs.existsSync(dbPath)) return 0;
  try {
    const db = openDatabase(dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
      return row?.v ?? 0;
    } finally { db.close(); }
  } catch { return 0; } // no table / unreadable → treat as fresh (nothing to protect)
}

export interface InstallOptions {
  /** Source plugin root (the built repo, or a staged artifact). Default cwd. */
  source?: string;
  /** Install root (user-scope). Default ~/.claude/xbus-install (overridable). */
  installRoot?: string;
  /** Broker data dir. Default <installRoot>/data. */
  dataDir?: string;
  dryRun?: boolean;
  json?: boolean;
  /** Injected clock (ISO) for deterministic manifests in tests. */
  nowIso?: string;
  /** Beta.4 (ADR 0012 D8): also register XBus into the user-scope Claude config so
   *  plain `claude` discovers it (no --plugin-dir). Default true. Tests/CI may set
   *  false (plugin-only install) or point `claudeConfigPath` at a temp file. */
  registerUserScope?: boolean;
  /** Override the user Claude MCP config path (tests). Default: platform ~/.claude.json. */
  claudeConfigPath?: string;
  /** Override the user Claude SETTINGS path where hooks live (tests). Default:
   *  platform ~/.claude/settings.json. */
  claudeSettingsPath?: string;
  /** Absolute node executable path written into the user-scope MCP/hook command.
   *  Default: the current process's node. */
  nodePath?: string;
}

export interface InstallPlan {
  action: 'install';
  source: string;
  installRoot: string;
  pluginDir: string;
  dataDir: string;
  filesToWrite: number;
  willBackup: string[];
  alreadyInstalled: boolean;
  /** The legacy runtime root + the migration decision. */
  legacyDataRoot: string;
  migration: MigrationDecision;
}

export interface InstallResult {
  ok: boolean;
  dryRun: boolean;
  plan: InstallPlan;
  manifestPath?: string;
  health?: { ok: boolean; detail: string };
  rolledBack?: boolean;
  migrated?: boolean;
  error?: string;
}

/** The payload directories/files that constitute the installable plugin.
 *  provenance.json travels with the install so installed binaries report the exact
 *  build identity (ADR 0011) with no git / no source checkout. */
const PAYLOAD = ['.claude-plugin', '.mcp.json', 'hooks', 'dist', 'package.json', 'provenance.json'];
const PAYLOAD_DEPS = ['uuid', 'zod'];

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(f); else yield f;
  }
}

/** Enumerate every source file that would be installed (relative paths). */
function enumeratePayload(source: string): string[] {
  const rels: string[] = [];
  for (const item of PAYLOAD) {
    const abs = path.join(source, item);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      for (const f of walk(abs)) rels.push(path.relative(source, f).replace(/\\/g, '/'));
    } else {
      rels.push(item);
    }
  }
  for (const dep of PAYLOAD_DEPS) {
    const abs = path.join(source, 'node_modules', dep);
    if (fs.existsSync(abs)) for (const f of walk(abs)) rels.push(path.relative(source, f).replace(/\\/g, '/'));
  }
  return rels;
}

export function planInstall(opts: InstallOptions = {}): InstallPlan {
  const source = opts.source ?? process.cwd();
  const installRoot = opts.installRoot ?? defaultInstallRoot();
  const pluginDir = path.join(installRoot, 'plugin');
  const dataDir = opts.dataDir ?? path.join(installRoot, 'data');
  // The source must be a valid plugin payload (use the SAME normative
  // contract the packager + doctor use, not an ad-hoc list). Works for either a
  // built repo OR a packaged artifact as the source.
  const srcContract = validateArtifact(source, { scope: 'plugin' });
  if (!srcContract.ok) {
    const missing = srcContract.violations.filter((x) => x.rule === 'required-file-missing').map((x) => x.detail);
    const detail = missing.length ? `missing ${missing.join(', ')}` : srcContract.violations.map((x) => `${x.rule}:${x.detail}`).join('; ');
    throw new Error(`source is not a valid XBus plugin payload (${detail}). For a repo source run \`npm run build\`; for an artifact use one produced by \`npm run package:win\`.`);
  }
  const rels = enumeratePayload(source);
  const willBackup = rels.map((r) => path.join(pluginDir, r)).filter((d) => fs.existsSync(d));
  // Classify the legacy runtime root (~/.claude/xbus) vs. the canonical
  // destination (dataDir) and decide whether a data-root migration is required.
  // legacyDataRoot is overridable via opts.dataDir-independent default; tests inject
  // it via XBUS_LEGACY_DATA_DIR.
  const legacyDataRoot = process.env.XBUS_LEGACY_DATA_DIR ?? defaultDataDir();
  // Only meaningful when the canonical dest differs from the legacy root.
  const migration: MigrationDecision = path.resolve(legacyDataRoot) === path.resolve(dataDir)
    ? { kind: 'no_migration', reason: 'legacy and canonical roots are the same path' }
    : decideMigration(summarizeRoot(legacyDataRoot), summarizeRoot(dataDir));
  return {
    action: 'install', source, installRoot, pluginDir, dataDir,
    filesToWrite: rels.length, willBackup,
    alreadyInstalled: readInstallManifest(installRoot) !== null,
    legacyDataRoot, migration,
  };
}

export async function install(opts: InstallOptions = {}): Promise<InstallResult> {
  const plan = planInstall(opts);
  if (opts.dryRun) return { ok: true, dryRun: true, plan };

  const { source, installRoot, pluginDir, dataDir } = plan;
  const now = opts.nowIso ?? new Date().toISOString();

  // FAIL CLOSED before any change if the legacy + canonical
  // roots hold non-identical runtime user data. Never auto-merge / pick-newest /
  // delete. The caller must resolve the conflict explicitly.
  if (plan.migration.kind === 'conflict') {
    return { ok: false, dryRun: false, plan, error: `XBUS_DATA_ROOT_CONFLICT: ${plan.migration.reason}` };
  }

  fs.mkdirSync(installRoot, { recursive: true });
  try { assertNotReparse(installRoot); } catch (e) { return { ok: false, dryRun: false, plan, error: (e as Error).message }; }

  // Hoisted so the OUTER catch can REVERSE a completed user-scope registration: if
  // the user-scope MCP/hooks write succeeded but a LATER step (manifest rewrite,
  // migration marker) throws, rollback must also unregister the two config files —
  // otherwise they're orphaned pointing at a plugin dir the rollback just deleted,
  // with no manifest left for `uninstall` to key off (adversarial-review minor).
  let userScopeToReverse: Parameters<typeof unregisterUserScope>[0] | undefined;

  // Stage into a temp dir alongside the final plugin dir, then swap atomically.
  const staging = path.join(installRoot, `.plugin.staging-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const files: InstallManifest['files'] = [];
  const backups: InstallManifest['backups'] = [];
  let swapped = false; // has the staging→pluginDir swap happened?
  try {
    const rels = enumeratePayload(source);
    for (const rel of rels) {
      const src = path.join(source, rel);
      const dst = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      // Checksum verification: the staged copy must match the source byte-for-byte.
      const srcHash = sha256(src);
      if (sha256(dst) !== srcHash) throw new Error(`checksum mismatch staging ${rel}`);
      files.push({ source: srcHash, dest: path.join(pluginDir, rel) });
    }

    // Back up any pre-existing destination files (then they will be overwritten
    // by the atomic swap). We back up the WHOLE prior pluginDir if present.
    if (fs.existsSync(pluginDir)) {
      const backupDir = path.join(installRoot, `.plugin.backup-${now.replace(/[:.]/g, '-')}`);
      fs.renameSync(pluginDir, backupDir);
      backups.push({ original: pluginDir, backup: backupDir });
    }
    // Atomic swap: staging -> pluginDir.
    fs.renameSync(staging, pluginDir);
    swapped = true;

    // Harden the install root + plugin dir (user-only ACL). The DATA dir is set up
    // AFTER the migration step below (migration may replace the whole data dir).
    try { hardenDir(installRoot); } catch { /* best effort */ }
    try { hardenDir(pluginDir); } catch { /* best effort */ }

    // If the legacy runtime root holds the authoritative
    // data, MIGRATE it into the canonical destination transactionally (journal +
    // backups + verify + atomic promote) BEFORE the secret/data-dir is initialized,
    // so loadOrCreateRootSecret never creates a fresh secret over authoritative data.
    let migrated = false;
    if (plan.migration.kind === 'migrate') {
      const migId = `mig-${now.replace(/[:.]/g, '-')}-${process.pid}`;
      const mr = migrateDataRoot({
        legacyRoot: plan.legacyDataRoot, canonicalRoot: dataDir,
        fromVersion: 'legacy-data-root', toVersion: XBUS_VERSION, migrationId: migId,
        backupDir: path.join(installRoot, `.data.migration-backup-${migId}`),
        journalPath: path.join(installRoot, `.data.migration-journal-${migId}.json`),
      });
      if (!mr.ok) {
        // migration failed + rolled back the data root; abort the whole install.
        const partial: InstallManifest = { schema: 1, name: 'xbus', version: XBUS_VERSION, commit: 'unknown', buildId: BUILD_ID, installedAt: now, installRoot, pluginDir, dataDir, files, backups };
        const rb = rollback(installRoot, partial);
        return { ok: false, dryRun: false, plan, rolledBack: rb, error: `data migration failed: ${mr.error} (final state ${mr.finalState})` };
      }
      migrated = mr.migrated;
    }

    fs.mkdirSync(dataDir, { recursive: true });
    try { hardenDir(dataDir); } catch { /* best effort */ }

    // Generate the per-installation secret SAFELY in the data dir (first use) —
    // a NO-OP when migration already promoted the authoritative secret.
    loadOrCreateRootSecret(dataDir);
    try { hardenFile(secretPath(dataDir)); } catch { /* best effort */ }

    // Write the install manifest (records files + backups for clean uninstall).
    // Record the installed artifact's manifest checksum (sha256 of
    // the source SHA256SUMS = the exact distributable identity) so `doctor` can
    // report exactly which artifact is installed. Absent when installing from a
    // built repo with no SHA256SUMS (dev install) → undefined, not an error.
    const artifactManifestSha256 = (() => {
      const sumsPath = path.join(source, 'SHA256SUMS');
      try { return fs.existsSync(sumsPath) ? createHash('sha256').update(fs.readFileSync(sumsPath)).digest('hex') : undefined; }
      catch { return undefined; }
    })();
    const manifest: InstallManifest = {
      schema: 1, name: 'xbus', version: XBUS_VERSION, commit: readCommit(source), buildId: BUILD_ID,
      installedAt: now, installRoot, pluginDir, dataDir, files, backups,
      ...(artifactManifestSha256 ? { artifactManifestSha256 } : {}),
    };
    fs.writeFileSync(manifestPath(installRoot), JSON.stringify(manifest, null, 2) + '\n');
    try { hardenFile(manifestPath(installRoot)); } catch { /* best effort */ }

    // Post-install health: (a) the installed plugin dir must satisfy the
    // plugin-scope contract (every reference resolves inside the installed
    // plugin), then (b) start a broker against the installed data dir + stop.
    // Roll back on any failure.
    const installedContract = validateArtifact(pluginDir, { scope: 'plugin', expectedVersion: XBUS_VERSION });
    if (!installedContract.ok) {
      const rb = rollback(installRoot, manifest);
      const detail = installedContract.violations.map((x) => `${x.rule}:${x.detail}`).join('; ');
      return { ok: false, dryRun: false, plan, health: { ok: false, detail: `installed plugin contract: ${detail}` }, rolledBack: rb, error: `installed plugin failed contract validation` };
    }
    // ADR 0019 D4 — DB snapshot BEFORE the health check migrates the live DB. The health
    // check starts a broker, which runs migrations on the live data dir; on ANY schema
    // INCREASE (e.g. 6→7) that migration is irreversible without a backup. So if the
    // on-disk schema is BELOW this build's SCHEMA_VERSION, snapshot the DB (+WAL/SHM) first
    // — the broker being installed is not yet running, so there is no live writer (the
    // stop-before-upgrade prerequisite). A health-check failure then restores the
    // pre-upgrade DB, so a failed upgrade leaves a WORKING prior install, not a
    // forward-migrated DB with a rolled-back plugin.
    const dbPath = path.join(dataDir, 'xbus.sqlite');
    const onDisk = onDiskSchemaVersion(dbPath);
    let dbSnapshot: { dir: string; manifest: SnapshotManifest | null } | null = null;
    if (onDisk > 0 && onDisk < SCHEMA_VERSION) {
      const snapDir = path.join(installRoot, `.db.snapshot-${now.replace(/[:.]/g, '-')}`);
      const nowMs = opts.nowIso ? Date.parse(opts.nowIso) : Date.parse(now);
      const manifest = snapshotDb(dbPath, snapDir, Number.isFinite(nowMs) ? nowMs : 0);
      dbSnapshot = { dir: snapDir, manifest };
    }
    const health = await healthCheck(dataDir);
    if (!health.ok) {
      // Restore the pre-upgrade DB (verified) BEFORE the plugin rollback, so the DB is not
      // left forward-migrated. A restore failure is surfaced in the error detail.
      let dbRestore = '';
      if (dbSnapshot?.manifest) {
        const r = restoreDbSnapshot(dbSnapshot.dir);
        dbRestore = r.ok ? ' (db restored to pre-upgrade snapshot)' : ` (db restore FAILED: ${r.detail})`;
      }
      if (dbSnapshot) discardSnapshot(dbSnapshot.dir);
      const rb = rollback(installRoot, manifest);
      return { ok: false, dryRun: false, plan, health, rolledBack: rb, error: `health check failed: ${health.detail}${dbRestore}` };
    }
    // Upgrade committed + verified — the pre-upgrade snapshot is no longer needed.
    if (dbSnapshot) discardSnapshot(dbSnapshot.dir);

    // Beta.4 (ADR 0012 D8): register XBus into the user-scope Claude config so plain
    // `claude` discovers it. Transactional inside the manager; a failure here rolls
    // back the WHOLE install (fail-closed: fully installed or fully reverted). The
    // installId (ownership tag) is the broker instance-independent install identity.
    const wantUserScope = opts.registerUserScope !== false;
    let userScope: InstallManifest['userScope'];
    if (wantUserScope) {
      const installId = `xbus-${now.replace(/[:.]/g, '-')}-${process.pid}`;
      const configPath = opts.claudeConfigPath ?? defaultClaudeConfigPath();
      const settingsPath = opts.claudeSettingsPath ?? defaultClaudeSettingsPath();
      const usrOpts = {
        configPath,
        settingsPath,
        nodePath: opts.nodePath ?? process.execPath,
        serverEntry: path.join(pluginDir, 'dist', 'channel', 'server.js'),
        hookEntry: path.join(pluginDir, 'dist', 'channel', 'hook-entry.js'),
        dataDir,
        installId,
      };
      const usr = registerUserScope(usrOpts);
      if (usr.ok) userScopeToReverse = usrOpts; // arm the rollback for any LATER throw
      if (!usr.ok) {
        const partial: InstallManifest = { schema: 1, name: 'xbus', version: XBUS_VERSION, commit: readCommit(source), buildId: BUILD_ID, installedAt: now, installRoot, pluginDir, dataDir, files, backups };
        const rb = rollback(installRoot, partial);
        return { ok: false, dryRun: false, plan, rolledBack: rb, error: `user-scope config registration failed: ${usr.error}` };
      }
      userScope = { configPath, settingsPath, registeredAt: now, ...(usr.backupPath ? { backupPath: usr.backupPath } : {}), ...(usr.settingsBackupPath ? { settingsBackupPath: usr.settingsBackupPath } : {}) };
      // Persist the userScope record + installId into the manifest (rewrite it).
      const updated: InstallManifest = { ...manifest, installId, userScope };
      fs.writeFileSync(manifestPath(installRoot), JSON.stringify(updated, null, 2) + '\n');
      try { hardenFile(manifestPath(installRoot)); } catch { /* best effort */ }
    }

    // After the upgrade commits (runtime installed + health verified),
    // write the durable migration marker so future installers skip the migration (§12).
    // The legacy source root is RETAINED (never deleted on the initial upgrade).
    if (migrated && !readMarker(dataDir)) {
      const src = summarizeRoot(plan.legacyDataRoot);
      writeMarker(dataDir, {
        migrationId: `committed-${now.replace(/[:.]/g, '-')}`,
        fromVersion: 'legacy-data-root', toVersion: XBUS_VERSION,
        legacyRoot: plan.legacyDataRoot, canonicalRoot: dataDir,
        sourceDatabaseHash: src.dbHash, sourceSecretHash: src.secretHash,
        completedAt: now, legacyRootRetentionStatus: 'retained',
        destinationBackupPath: null,
      });
    }

    return { ok: true, dryRun: false, plan, manifestPath: manifestPath(installRoot), health, migrated };
  } catch (e) {
    // Full rollback on ANY failure (incl. post-swap errors like secret/data-dir
    // creation): remove a swapped plugin dir, restore the most recent backup,
    // and clean staging + any partial manifest. Leaves the install root as it was.
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    // Reverse a COMPLETED user-scope registration first (best-effort), so a throw
    // after it succeeded does not orphan ~/.claude.json + ~/.claude/settings.json
    // entries pointing at the plugin dir we are about to delete.
    if (userScopeToReverse) { try { unregisterUserScope(userScopeToReverse); } catch { /* best effort */ } }
    let rolledBack = false;
    try {
      if (swapped && fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true, force: true });
      const b = backups[backups.length - 1];
      if (b && fs.existsSync(b.backup)) fs.renameSync(b.backup, b.original);
      if (fs.existsSync(manifestPath(installRoot))) fs.rmSync(manifestPath(installRoot), { force: true });
      rolledBack = true;
    } catch { /* best effort */ }
    return { ok: false, dryRun: false, plan, error: (e as Error).message, rolledBack };
  }
}

function readCommit(source: string): string {
  // Embedded build-manifest.json (from packaging) carries the commit; else unknown.
  try {
    const bm = JSON.parse(fs.readFileSync(path.join(source, 'build-manifest.json'), 'utf8')) as { commit?: string };
    return bm.commit ?? 'unknown';
  } catch { return 'unknown'; }
}

async function healthCheck(dataDir: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const broker = await startBrokerHost({ dataDir, reaperIntervalMs: 0 });
    // ACL of the secret must be owner-only.
    const acl = describeAcl(secretPath(dataDir));
    await broker.stop();
    if (acl.broadAccess) return { ok: false, detail: 'root secret has broad ACL' };
    return { ok: true, detail: 'broker started + stopped cleanly; secret ACL owner-only' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

function rollback(installRoot: string, manifest: InstallManifest): boolean {
  try {
    fs.rmSync(manifest.pluginDir, { recursive: true, force: true });
    // Restore the most recent backup, if any.
    const b = manifest.backups[manifest.backups.length - 1];
    if (b && fs.existsSync(b.backup)) fs.renameSync(b.backup, b.original);
    fs.rmSync(manifestPath(installRoot), { force: true });
    return true;
  } catch { return false; }
}

// ───────────────────────────── uninstall ─────────────────────────────

export interface UninstallOptions {
  installRoot?: string;
  removeData?: boolean; // remove the broker data dir + secret too
  dryRun?: boolean;
  json?: boolean;
}

export interface UninstallResult {
  ok: boolean;
  dryRun: boolean;
  installRoot: string;
  removed: string[];
  retainedData: boolean;
  couldNotRemove: string[];
  notInstalled: boolean;
}

export function uninstall(opts: UninstallOptions = {}): UninstallResult {
  const installRoot = opts.installRoot ?? defaultInstallRoot();
  const manifest = readInstallManifest(installRoot);
  if (!manifest) {
    return { ok: true, dryRun: !!opts.dryRun, installRoot, removed: [], retainedData: true, couldNotRemove: [], notInstalled: true };
  }
  const toRemove = [manifest.pluginDir, manifestPath(installRoot)];
  if (opts.removeData) toRemove.push(manifest.dataDir);

  if (opts.dryRun) {
    return { ok: true, dryRun: true, installRoot, removed: toRemove, retainedData: !opts.removeData, couldNotRemove: [], notInstalled: false };
  }

  const removed: string[] = [];
  const couldNotRemove: string[] = [];
  // Beta.4 (ADR 0012 D8): reverse the user-scope Claude config registration FIRST,
  // removing ONLY the entries THIS install owns (ownership-tagged). The user's other
  // mcp servers/hooks are never touched. Best-effort: a config-edit failure must not
  // block removing the plugin/data files.
  if (manifest.userScope && manifest.installId) {
    try {
      const u = unregisterUserScope({
        configPath: manifest.userScope.configPath,
        settingsPath: manifest.userScope.settingsPath,
        nodePath: process.execPath,
        serverEntry: path.join(manifest.pluginDir, 'dist', 'channel', 'server.js'),
        hookEntry: path.join(manifest.pluginDir, 'dist', 'channel', 'hook-entry.js'),
        dataDir: manifest.dataDir,
        installId: manifest.installId,
      });
      if (u.removed) removed.push(`user-scope:${manifest.userScope.configPath}`);
    } catch { couldNotRemove.push(`user-scope:${manifest.userScope.configPath}`); }
  }
  for (const target of toRemove) {
    try {
      if (fs.existsSync(target)) { fs.rmSync(target, { recursive: true, force: true }); removed.push(target); }
    } catch { couldNotRemove.push(target); }
  }
  // Remove leftover backups created by installs.
  try {
    for (const e of fs.readdirSync(installRoot)) {
      if (e.startsWith('.plugin.backup-')) { fs.rmSync(path.join(installRoot, e), { recursive: true, force: true }); }
    }
  } catch { /* ignore */ }
  // If data retained, leave installRoot (holds data); else remove it if empty.
  if (opts.removeData) {
    try { if (fs.existsSync(installRoot) && fs.readdirSync(installRoot).length === 0) fs.rmSync(installRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { ok: couldNotRemove.length === 0, dryRun: false, installRoot, removed, retainedData: !opts.removeData, couldNotRemove, notInstalled: false };
}

// Silence unused import in type-only builds.
void os;
