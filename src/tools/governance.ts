/**
 * Beta.9 (ADR 0029): opt-in governance integration for AgenTel.
 *
 * Three capabilities, all SCOPED to a repo that explicitly opts in — governance is INERT for any
 * repo without an `.agentel/governance.json`, so dropping AgenTel into an arbitrary checkout never
 * silently gates its pushes (the exact cross-repo failure mode that motivated this: a global hook
 * intercepting an unrelated repo's pushes). Nothing here mutates a foreign framework's files.
 *
 *   1. reviewer discovery + install — find a `code-reviewer.md` reviewer agent in known locations
 *      and install it into a session-visible `.claude/agents/` dir so `subagent_type:code-reviewer`
 *      resolves on the next session (agent defs load at session start).
 *   2. governance-config gate — `isGovernanceEnabled(repo)` is true ONLY when the opt-in file
 *      exists AND names this repo (or uses "*"). Callers no-op otherwise.
 *   3. verification-evidence emission — after `agentel verify` passes, write gate evidence in the
 *      EXACT format the preflight pre-push-gate reads (`.preflight/gate/<name>` with `GATE=`,
 *      `HEAD=<sha>`, `TIMESTAMP=` lines), so a governed repo's push gate recognizes a genuine
 *      AgenTel verification instead of demanding a foreign (dotnet) test run.
 *
 * PURE where possible; fs effects are explicit + best-effort (never throw into a caller's happy
 * path). Windows-first (forward-slashes normalized by path).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Opt-in config file, relative to the repo root. Presence + match = governance ON. */
export const GOVERNANCE_CONFIG_REL = path.join('.agentel', 'governance.json');

/** Known filenames for the Stage-1 reviewer agent (first match wins). */
const REVIEWER_AGENT_FILENAME = 'code-reviewer.md';

export interface GovernanceConfig {
  /** Repos this config governs: absolute paths, repo folder names, or "*" for any. */
  repos?: string[];
  /** Emit preflight gate evidence after a passing `agentel verify`. Default true when governed. */
  emitPreflightEvidence?: boolean;
  /** Gate names to stamp (matching the consuming pre-push-gate). Default ['tests-pass','stage1-clean']. */
  gateNames?: string[];
}

/** Read + parse the opt-in config, or null if absent/invalid. */
export function readGovernanceConfig(repoRoot: string): GovernanceConfig | null {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, GOVERNANCE_CONFIG_REL), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // `parsed` is narrowed to a non-null object. GovernanceConfig is entirely optional fields, so
    // a plain object structurally satisfies it — assign directly (no assertion needed). Every
    // consumer reads fields defensively, so an unexpected shape degrades to "no opinion".
    return parsed;
  } catch { return null; }
}

/**
 * Is governance enabled for this repo? True ONLY when the opt-in file exists AND its `repos` list
 * matches this repo (by absolute path, by basename, or "*"). An empty/absent `repos` defaults to
 * "this repo only" (presence of the file in the repo IS the opt-in), so a hand-authored minimal
 * `{}` governs the repo it lives in — but never any OTHER repo.
 */
export function isGovernanceEnabled(repoRoot: string): boolean {
  const cfg = readGovernanceConfig(repoRoot);
  if (!cfg) return false;
  const repos = cfg.repos;
  if (!repos || repos.length === 0) return true; // file present in-repo = opt-in for THIS repo
  const abs = path.resolve(repoRoot);
  const base = path.basename(abs);
  return repos.some((r) => r === '*' || path.resolve(r) === abs || r === base);
}

export interface ReviewerDiscovery {
  found: boolean;
  /** Absolute source path of the reviewer agent, when found. */
  sourcePath?: string;
  /** Where it was found (for the report). */
  origin?: string;
}

/**
 * Discover a `code-reviewer.md` reviewer agent. Search order (first hit wins):
 *   1. AGENTEL_REVIEWER_AGENT env → an explicit path
 *   2. <repo>/.claude/agents/code-reviewer.md          (already installed here)
 *   3. <repo>/agents/code-reviewer.md                  (repo-vendored)
 *   4. any extraSearchDirs the caller supplies (e.g. a sibling framework's agents/ dir)
 * PURE via the injected `exists` probe.
 */
export function discoverReviewerAgent(
  repoRoot: string,
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
  extraSearchDirs: string[] = [],
): ReviewerDiscovery {
  const candidates: Array<{ p: string; origin: string }> = [];
  const envPath = env.AGENTEL_REVIEWER_AGENT;
  if (envPath) candidates.push({ p: envPath, origin: 'AGENTEL_REVIEWER_AGENT' });
  candidates.push({ p: path.join(repoRoot, '.claude', 'agents', REVIEWER_AGENT_FILENAME), origin: 'repo .claude/agents' });
  candidates.push({ p: path.join(repoRoot, 'agents', REVIEWER_AGENT_FILENAME), origin: 'repo agents/' });
  for (const d of extraSearchDirs) candidates.push({ p: path.join(d, REVIEWER_AGENT_FILENAME), origin: d });
  for (const c of candidates) {
    if (exists(c.p)) return { found: true, sourcePath: c.p, origin: c.origin };
  }
  return { found: false };
}

export interface ReviewerInstallResult {
  ok: boolean;
  installedTo?: string;
  source?: string;
  detail: string;
  /** True when the target already held a byte-identical copy (idempotent no-op). */
  alreadyPresent?: boolean;
}

/**
 * Install the discovered reviewer agent into `<repoRoot>/.claude/agents/code-reviewer.md` so
 * `subagent_type:'code-reviewer'` resolves next session. Idempotent: a byte-identical existing
 * file is left untouched (never dirties the tree on a rerun). Best-effort; returns a result rather
 * than throwing.
 */
export function installReviewerAgent(repoRoot: string, discovery: ReviewerDiscovery): ReviewerInstallResult {
  if (!discovery.found || !discovery.sourcePath) {
    return { ok: false, detail: 'no code-reviewer.md reviewer agent found in any known location; set AGENTEL_REVIEWER_AGENT or vendor one under agents/' };
  }
  const target = path.join(repoRoot, '.claude', 'agents', REVIEWER_AGENT_FILENAME);
  try {
    const src = fs.readFileSync(discovery.sourcePath, 'utf8');
    if (fs.existsSync(target)) {
      const cur = fs.readFileSync(target, 'utf8');
      if (cur === src) return { ok: true, installedTo: target, source: discovery.sourcePath, detail: 'already installed (byte-identical) — no change', alreadyPresent: true };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, src);
    return { ok: true, installedTo: target, source: discovery.sourcePath, detail: `installed from ${discovery.origin} (registers on next session start)` };
  } catch (e) {
    return { ok: false, source: discovery.sourcePath, detail: `install failed: ${(e as Error).message}` };
  }
}

export interface EvidenceResult {
  ok: boolean;
  written: string[];
  skippedReason?: string;
}

/**
 * Emit preflight gate evidence for a governed repo after a PASSING `agentel verify`. Writes each
 * gate file under `<repo>/.preflight/gate/` in the exact format the pre-push-gate parses:
 * `GATE=<name>\nHEAD=<sha>\nTIMESTAMP=<iso>\nSOURCE=agentel-verify\n`. No-op (with a reason) when
 * governance is off or verify did not pass — NEVER fabricates evidence for a failing verify.
 *
 * `headSha` + `nowIso` are passed in (the caller stamps them from git + the clock) so this stays
 * pure of ambient time and testable.
 */
export function emitPreflightEvidence(
  repoRoot: string,
  opts: { verifyPassed: boolean; headSha: string; nowIso: string; gateNames?: string[] },
): EvidenceResult {
  if (!isGovernanceEnabled(repoRoot)) return { ok: false, written: [], skippedReason: 'governance not enabled for this repo (no matching .agentel/governance.json)' };
  if (!opts.verifyPassed) return { ok: false, written: [], skippedReason: 'agentel verify did not pass — refusing to write gate evidence' };
  const cfg = readGovernanceConfig(repoRoot);
  if (cfg?.emitPreflightEvidence === false) return { ok: false, written: [], skippedReason: 'emitPreflightEvidence disabled in governance config' };
  const gateNames = opts.gateNames ?? cfg?.gateNames ?? ['tests-pass', 'stage1-clean'];
  const gateDir = path.join(repoRoot, '.preflight', 'gate');
  const written: string[] = [];
  try {
    fs.mkdirSync(gateDir, { recursive: true });
    for (const name of gateNames) {
      const file = path.join(gateDir, name);
      fs.writeFileSync(file, `GATE=${name}\nHEAD=${opts.headSha}\nTIMESTAMP=${opts.nowIso}\nSOURCE=agentel-verify\n`);
      written.push(file);
    }
    return { ok: true, written };
  } catch (e) {
    return { ok: false, written, skippedReason: `evidence write failed: ${(e as Error).message}` };
  }
}
