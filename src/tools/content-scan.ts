/**
 * Content scanner (§7 packaging + §9 docs). One source of truth for "this text
 * must not ship to the public": private/local paths, the developer's machine
 * identity, secret-shaped material, and prohibited internal terms.
 *
 * Pure + dependency-free so it runs in CI, in the packaging script, and in tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The current public repository's HEAD commit (full SHA), or '' if unavailable.
 * A SHA equal to (or a prefix of) this value is the project's OWN commit and is
 * allowed to appear in build/provenance metadata — it refers to the current
 * public repo, not private development provenance. Resolved once, lazily.
 */
let _currentCommit: string | null = null;
function currentRepoCommit(): string {
  if (_currentCommit !== null) return _currentCommit;
  try { _currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { _currentCommit = ''; }
  return _currentCommit;
}
/** Allow extra known-public SHAs (e.g. injected for tests / CI). */
const ENV_ALLOWED_SHAS = (process.env.XBUS_SCAN_ALLOWED_COMMITS ?? '').split(/[,\s]+/).filter(Boolean);

export interface ScanHit {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}

export interface ScanRule {
  id: string;
  /** Regex matched per line. */
  pattern: RegExp;
  /** Optional allow predicate — return true to suppress a match (false positive). */
  allow?: (line: string) => boolean;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Optional, EXTERNAL private denylist. The public scanner ships NO private
 * identifiers — not as literals, and not as a reversible encoding. Instead, the
 * concrete values to reject (a developer username, an employer domain, internal
 * host tags, private repo/program names, known private commit SHAs, etc.) are
 * loaded at runtime from an external file that is NOT committed to the public
 * repository. This keeps the public source provenance-free while preserving full
 * detection on the maintainer's machine and in CI.
 *
 * Source of the denylist (first match wins):
 *   1. $XBUS_SCAN_DENYLIST_FILE — explicit path to a JSON file
 *   2. <cwd>/.xbus-scan-denylist.json — a gitignored local/CI file
 * Shape: { "identifiers": string[], "commitShas": string[] }
 * Absent file → empty denylist (the structural rules below still apply).
 */
export interface PrivateDenylist { identifiers: string[]; commitShas: string[]; }
export function loadPrivateDenylist(cwd: string = process.cwd()): PrivateDenylist {
  const candidates = [process.env.XBUS_SCAN_DENYLIST_FILE, path.join(cwd, '.xbus-scan-denylist.json')].filter(Boolean) as string[];
  for (const f of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as Partial<PrivateDenylist>;
      return { identifiers: raw.identifiers ?? [], commitShas: raw.commitShas ?? [] };
    } catch { /* try next */ }
  }
  return { identifiers: [], commitShas: [] };
}

/**
 * The STRUCTURAL, provenance-free rules. These ship in the public source and
 * contain no private value: generic home-path shapes, secret-shaped material,
 * and a git-context SHA detector that rejects UNKNOWN hashes by default while
 * allowlisting the current public commit + obvious synthetic fixtures.
 */
export const STRUCTURAL_RULES: ScanRule[] = [
  {
    id: 'windows-user-path',
    pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/i,
    // Allow a deliberately-generic placeholder used in docs.
    allow: (l) => /<user>|YourName|%USERNAME%|\\Users\\you\b/i.test(l),
  },
  { id: 'unix-home-path', pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+\//, allow: (l) => /\/Users\/you\b|<user>/.test(l) },
  { id: 'pem-block', pattern: /-----BEGIN (?:RSA |EC )?(?:PRIVATE KEY|CERTIFICATE)-----/ },
  // A long base64 run on a line that also mentions secret/key/token.
  { id: 'inline-secret', pattern: /(secret|api[_-]?key|token|password)\s*[:=]\s*['"]?[A-Za-z0-9+/]{24,}/i, allow: (l) => /example|REDACTED|xxxx|<your|placeholder|\$\{/i.test(l) },
  // STRUCTURAL: pre-release "rc.N" version/tag strings. Generic pattern (no private
  // value); flags any internal release-candidate label that should not ship publicly.
  // Allowlisted only where annotated as a synthetic/example fixture.
  { id: 'prerelease-rc-tag', pattern: /\b(?:v?\d+\.\d+\.\d+-)?rc\.[0-9]+\b/i, allow: (l) => /synthetic|placeholder|fixture|example|e\.g\./i.test(l) },
  // STRUCTURAL: any git-context SHA-like value (>=7 hex) appearing next to a
  // git/commit/HEAD/tag/build cue. Rejects UNKNOWN hashes by default; the
  // allowlist below clears synthetic fixtures + the current public commit.
  {
    id: 'unrecognized-git-sha',
    pattern: /\b(?:commit|HEAD|sha|tag|build|rev|ref)\b[^\n]{0,40}\b[0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\b[^\n]{0,20}\b(?:commit|sha)\b/i,
    allow: (l) => {
      // Allow obviously-synthetic placeholder fixtures (all-same-digit runs),
      // crypto test vectors (hex without a git cue is handled by the pattern's
      // git-context requirement), and lines explicitly annotated as synthetic.
      if (/(.)\1{6,}/.test(l)) return true;                       // 1111…, 2222…, deadbeef-style repeats
      if (/synthetic|placeholder|fixture|example|non-resolving|test\./i.test(l)) return true;
      if (/0{7,}|f{7,}|deadbeef|abcdef0/i.test(l)) return true;   // canonical dummy hashes
      // Allow the project's OWN current commit (refers to the current public
      // repo — e.g. build-manifest.json / runtime.json / provenance.json), plus
      // any explicitly env-allowlisted public SHA.
      const head = currentRepoCommit();
      const allowed = [head, ...ENV_ALLOWED_SHAS].filter(Boolean);
      for (const sha of allowed) {
        if (!sha) continue;
        const hexes = l.match(/\b[0-9a-f]{7,40}\b/gi) ?? [];
        // every git-SHA-looking token on the line must be a prefix of an allowed SHA
        if (hexes.length > 0 && hexes.every((h) => sha.startsWith(h.toLowerCase()) || h.toLowerCase().startsWith(sha))) return true;
      }
      return false;
    },
  },
];

/** Build the rules derived from an external private denylist (empty if none). */
export function denylistRules(dl: PrivateDenylist): ScanRule[] {
  const rules: ScanRule[] = [];
  const idents = dl.identifiers.filter(Boolean).map(esc);
  if (idents.length) rules.push({ id: 'private-identifier', pattern: new RegExp('(?:' + idents.join('|') + ')', 'i') });
  const shas = dl.commitShas.filter(Boolean).map(esc);
  if (shas.length) rules.push({ id: 'private-commit-sha', pattern: new RegExp('\\b(?:' + shas.join('|') + ')[0-9a-f]*\\b', 'i') });
  return rules;
}

/**
 * The full default rule set = structural rules (provenance-free, in source) +
 * the rules derived from the EXTERNAL private denylist (loaded at runtime; empty
 * when the gitignored denylist file is absent — e.g. in a fresh public clone).
 */
export const DEFAULT_RULES: ScanRule[] = [...STRUCTURAL_RULES, ...denylistRules(loadPrivateDenylist())];

const TEXT_EXT = new Set(['.ts', '.js', '.json', '.md', '.txt', '.yml', '.yaml', '.sh', '.ps1', '.cjs', '.mjs']);

function* walk(dir: string, ignore: (p: string) => boolean): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ignore(full)) continue;
    if (ent.isDirectory()) yield* walk(full, ignore);
    else yield full;
  }
}

export interface ScanOptions {
  rules?: ScanRule[];
  /** Extra paths (relative) to ignore. node_modules/.git/dist are always ignored. */
  ignore?: (absPath: string) => boolean;
  /** Only scan these extensions (default: common text types). */
  extensions?: Set<string>;
}

/** Scan a directory tree; return every prohibited-content hit. */
export function scanTree(root: string, opts: ScanOptions = {}): ScanHit[] {
  const rules = opts.rules ?? DEFAULT_RULES;
  const exts = opts.extensions ?? TEXT_EXT;
  const ignore = (p: string): boolean => {
    const norm = p.replace(/\\/g, '/');
    // node_modules/.git/coverage are always skipped. dist/ is NOT exempted —
    // generated output is public-bound and must be scanned for leaked
    // provenance (a public-sanitization requirement).
    if (/\/(node_modules|\.git|coverage)(\/|$)/.test(norm)) return true;
    return opts.ignore ? opts.ignore(p) : false;
  };
  const hits: ScanHit[] = [];
  for (const file of walk(root, ignore)) {
    if (!exts.has(path.extname(file))) continue;
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const rule of rules) {
        if (rule.pattern.test(line) && !(rule.allow?.(line))) {
          hits.push({ file: path.relative(root, file), line: i + 1, rule: rule.id, excerpt: line.trim().slice(0, 120) });
        }
      }
    }
  }
  return hits;
}
