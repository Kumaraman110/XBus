/**
 * BETA.10 WS4 — architecture-guard: the provider-NEUTRAL core (src/broker) must not read a host's
 * env vars or on-disk layout directly. Host-specific identity/discovery belongs behind the adapter
 * (src/adapter/session-identity.ts) and is read ONLY at the channel edge (src/channel/*).
 *
 * This test statically scans src/broker/*.ts for CLAUDE_* env reads and .claude path literals in
 * NON-COMMENT code, so the boundary can't silently erode. Known, accepted exception: session-import
 * (dormant-session DISCOVERY) resolves the transcripts root — but only via the injectable
 * XBUS_CLAUDE_PROJECTS_DIR override / defaultProjectsDir(), which the ClaudeCodeAdapter also uses;
 * it is allow-listed here and slated to route through the adapter's transcriptsRoot(). Any NEW
 * broker-core Claude coupling fails this guard.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROKER = path.resolve(HERE, '..', '..', 'src', 'broker');

/** Allow-listed files with a documented, injectable host-discovery exception (WS4 slated). */
const ALLOWED = new Set(['session-import.ts']);

/** Strip line + block comments so we only flag REAL code (comments mentioning CLAUDE_ are fine). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'); // line comments
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('WS4 architecture guard — src/broker core is provider-neutral', () => {
  it('no src/broker file reads a CLAUDE_* env var in non-comment code (dotted, bracket, or destructured; except allow-listed)', () => {
    // Package-B adversarial finding: the original /process\.env\.CLAUDE_[A-Z_]+/ caught only dotted
    // access and missed process.env['CLAUDE_X'] and `const { CLAUDE_X } = process.env`. Broadened to
    // all three access shapes so a future bracket/destructure coupling cannot slip in unseen.
    const patterns: RegExp[] = [
      /process\.env\.CLAUDE_[A-Z_]+/,                       // process.env.CLAUDE_X
      /process\.env\s*\[\s*['"`]CLAUDE_[A-Z_]+['"`]\s*\]/,   // process.env['CLAUDE_X']
      /\{[^}]*\bCLAUDE_[A-Z_]+\b[^}]*\}\s*=\s*process\.env/, // const { CLAUDE_X } = process.env
    ];
    const offenders: string[] = [];
    for (const f of tsFiles(BROKER)) {
      if (ALLOWED.has(path.basename(f))) continue;
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (patterns.some((re) => re.test(code))) offenders.push(path.relative(BROKER, f));
    }
    expect(offenders, `broker core reads CLAUDE_* env: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no src/broker file couples to a .claude on-disk path in non-comment code (single-literal OR segmented join; except allow-listed)', () => {
    // Package-B adversarial finding: the original single-literal regex required ".claude" + a slash
    // INSIDE one string literal, so a segmented path.join(homedir(), '.claude', 'projects') — where
    // '.claude' is its own quoted segment — evaded it. Catch BOTH shapes.
    const singleLiteral = /['"`][^'"`]*\.claude[/\\][^'"`]*['"`]/;          // '.../.claude/...'
    const segmentedClaudeSegment = /['"`]\.claude['"`]/;                     // a bare '.claude' path segment (join arg)
    const offenders: string[] = [];
    for (const f of tsFiles(BROKER)) {
      if (ALLOWED.has(path.basename(f))) continue;
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (singleLiteral.test(code) || segmentedClaudeSegment.test(code)) offenders.push(path.relative(BROKER, f));
    }
    expect(offenders, `broker core couples to a .claude path: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the one allow-listed exception (session-import) resolves its root via the injectable override, not a bare hard-code', () => {
    const code = fs.readFileSync(path.join(BROKER, 'session-import.ts'), 'utf8');
    // it MUST read the override env first (injectable), so tests + the adapter can redirect it.
    expect(code.includes('XBUS_CLAUDE_PROJECTS_DIR'), 'session-import transcripts root must be injectable').toBe(true);
  });
});
