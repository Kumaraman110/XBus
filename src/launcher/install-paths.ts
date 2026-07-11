/**
 * Install-location helpers shared by `xbus install/uninstall` and `xclaude`.
 *
 * All paths are USER-SCOPE. The default install root is under the user's home;
 * tests and non-default installs pass an explicit root. Nothing here touches
 * PATH, the registry, or a PowerShell profile.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Default user-scope install root: ~/.claude/xbus-install (NOT the data dir). */
export function defaultInstallRoot(): string {
  return process.env.XBUS_INSTALL_ROOT ?? path.join(os.homedir(), '.claude', 'xbus-install');
}

export function manifestPath(installRoot: string): string {
  return path.join(installRoot, 'install-manifest.json');
}

export interface InstallManifestFile {
  source: string; // SHA-256
  dest: string;   // absolute path written
}

export interface InstallManifest {
  schema: 1;
  name: string;
  version: string;
  commit: string;
  buildId: string;
  installedAt: string;
  installRoot: string;
  pluginDir: string;       // dir passed to `claude --plugin-dir`
  dataDir: string;         // the broker data dir (secret lives here)
  files: InstallManifestFile[]; // every file this install created (for clean uninstall)
  backups: Array<{ original: string; backup: string }>; // pre-existing files we backed up
  /** sha256 of the installed artifact's SHA256SUMS — the exact distributable
   *  identity (see ADR 0011). Absent for a dev install from a built repo (no SHA256SUMS). */
  artifactManifestSha256?: string;
  /** Beta.4 (ADR 0012 D8): a unique id for THIS install, used as the ownership tag
   *  on user-scope Claude config entries so uninstall removes only what we created. */
  installId?: string;
  /** Beta.4: record of the user-scope Claude MCP+hooks registration (so uninstall
   *  can reverse it, and doctor/repair can detect drift). Absent if not registered.
   *  MCP servers live in configPath (~/.claude.json); hooks live in settingsPath
   *  (~/.claude/settings.json) — two distinct files Claude Code reads separately. */
  userScope?: {
    configPath: string;
    settingsPath: string;
    registeredAt: string;
    /** Pre-install backups (restorable). */
    backupPath?: string;
    settingsBackupPath?: string;
  };
}

export function readInstallManifest(installRoot: string): InstallManifest | null {
  const p = manifestPath(installRoot);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as InstallManifest; }
  catch { return null; }
}

/** The uninstalled default broker data dir (used only when nothing is installed). */
export function defaultDataDir(): string {
  return path.join(os.homedir(), '.claude', 'xbus');
}

/**
 * The canonical data root (spec §5): the SINGLE authoritative broker data root that
 * EVERY component (broker `start`, `doctor`, `status`, the MCP server, the
 * checkpoint hook, install/uninstall) must agree on. Precedence:
 *   1. an explicit `XBUS_DATA_DIR` override (tests, trials, isolated profiles);
 *   2. the INSTALLED manifest's `dataDir` (so a real install's broker, MCP server,
 *      and hooks all use the data dir the installer provisioned + hardened —
 *      so `<installRoot>/data` is never orphaned);
 *   3. the uninstalled default `~/.claude/xbus` (running from source / no install).
 * `xclaude` also injects this value into the launched child's `XBUS_DATA_DIR`, so a
 * Claude session started via `xclaude` resolves the same root deterministically.
 */
export function resolveDataDir(): string {
  if (process.env.XBUS_DATA_DIR) return process.env.XBUS_DATA_DIR;
  const manifest = readInstallManifest(defaultInstallRoot());
  if (manifest?.dataDir) return manifest.dataDir;
  return defaultDataDir();
}
