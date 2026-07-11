/**
 * Project identity. A stable id for the canonical working directory (or its git
 * repository root). cwd is metadata, not a security identity (sender identity
 * always comes from the authenticated connection).
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { safeRemoteHashInput } from '../observability/redaction.js';

/** Canonicalize a path: resolve, normalize separators, lowercase drive on win32. */
export function canonicalizePath(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(p);
  } catch {
    resolved = path.resolve(p);
  }
  if (process.platform === 'win32') {
    // Normalize drive-letter casing and separators.
    resolved = resolved.replace(/\\/g, '/');
    resolved = resolved.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  }
  return resolved;
}

/** Find the git repo root for a directory, if any (walk up looking for .git). */
export function findRepositoryRoot(cwd: string): string | undefined {
  let dir = canonicalizePath(cwd);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Stable project id = sha256 of the repo root (if any) else the canonical cwd. */
export function computeProjectId(cwd: string): string {
  const root = findRepositoryRoot(cwd) ?? canonicalizePath(cwd);
  return 'proj-' + createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 16);
}

/** Hash a git remote URL with credentials stripped (never store raw remote). */
export function repositoryRemoteHash(remoteUrl: string): string {
  return createHash('sha256').update(safeRemoteHashInput(remoteUrl), 'utf8').digest('hex').slice(0, 16);
}

/** The name-suggestion inputs shape (mirrors session-name.ts NameSuggestionInputs;
 *  duplicated here as a plain interface to avoid a project<->session-name import
 *  cycle — the caller passes this straight to suggestSessionName). */
export interface WorkspaceSuggestion {
  savedName?: string;
  gitRepo?: string;
  dirName?: string;
  agentType?: string;
  projectId?: string;
}

/**
 * Derive name-suggestion inputs from a working directory (beta.4, ADR 0012
 * Decision 3): the git repository root's basename (if any) + the cwd basename,
 * plus the caller's agentType/projectId/savedName for the fallbacks. Pure read of
 * the filesystem (no writes). Feed the result to `suggestSessionName`.
 */
export function deriveWorkspaceSuggestion(cwd: string, opts: { agentType?: string; projectId?: string; savedName?: string } = {}): WorkspaceSuggestion {
  const out: WorkspaceSuggestion = {};
  if (opts.savedName !== undefined) out.savedName = opts.savedName;
  const repoRoot = findRepositoryRoot(cwd);
  if (repoRoot) {
    const repoName = path.basename(repoRoot);
    if (repoName) out.gitRepo = repoName;
  }
  const dirName = path.basename(canonicalizePath(cwd));
  if (dirName) out.dirName = dirName;
  if (opts.agentType !== undefined) out.agentType = opts.agentType;
  if (opts.projectId !== undefined) out.projectId = opts.projectId;
  return out;
}
