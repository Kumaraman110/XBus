/**
 * CI content scan over the WHOLE repository source tree (not just the published
 * artifact). The entire tracked tree must contain NO private/local paths,
 * developer identity, internal provenance, or secret-shaped material.
 *
 * The scanner itself ships NO private values: structural rules are in source, and
 * the concrete private denylist is loaded from an EXTERNAL, gitignored file
 * (`.xbus-scan-denylist.json`) that is never committed to the public repo. So this
 * test excludes (a) the gitignored denylist file (legitimately holds the values),
 * (b) package-win (references forbidden-dep names), (c) transient build/dist output
 * (scanned separately over the built artifact), and (d) test fixtures that build OS
 * temp paths at runtime. content-scan.ts itself is now scanned — it contains no
 * private value.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTree, denylistRules, loadPrivateDenylist } from '../../src/tools/content-scan.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function isExcluded(norm: string): boolean {
  return /\.xbus-scan-denylist\.json$/.test(norm)      // EXTERNAL gitignored denylist — holds the values by design, never committed
    || /src\/tools\/package-win\.ts$/.test(norm)       // references forbidden-dep names
    || /tests\/integration\/content-scan\.test\.ts$/.test(norm) // this file
    || /\/build\//.test(norm)                          // transient packaging output
    || /\/dist\//.test(norm)                           // generated output — scanned separately over the built artifact
    || /\/tests\//.test(norm);                         // fixtures build real temp paths at runtime
}

describe('content scan — whole-repo (no private terms / paths / secrets / provenance)', () => {
  it('the entire source tree contains no prohibited content', () => {
    const hits = scanTree(REPO, { ignore: (p) => isExcluded(p.replace(/\\/g, '/')) });
    if (hits.length > 0) {
      const detail = hits.map((h) => `  ${h.rule}  ${h.file}:${h.line}  ${h.excerpt}`).join('\n');
      throw new Error(`content scan found ${hits.length} prohibited item(s):\n${detail}`);
    }
    expect(hits).toHaveLength(0);
  });

  it('the tests/ tree carries no private identifier (denylist rules only; temp-path fixtures allowed)', () => {
    // tests/ is excluded from the structural home-path rules (fixtures build real
    // OS temp paths at runtime), but it must still be free of denylisted private
    // identifiers + commit SHAs — closing the gap where a leak hides in an excluded
    // test file. Run ONLY the denylist rules (no home-path false positives), over
    // the whole test tree except this guard + the gitignored denylist.
    const rules = denylistRules(loadPrivateDenylist(REPO));
    if (rules.length === 0) return; // no external denylist present (fresh clone) — nothing to assert
    const hits = scanTree(path.join(REPO, 'tests'), {
      rules,
      ignore: (p) => /content-scan\.test\.ts$/.test(p.replace(/\\/g, '/')),
    });
    if (hits.length > 0) {
      const detail = hits.map((h) => `  ${h.rule}  tests/${h.file}:${h.line}  ${h.excerpt}`).join('\n');
      throw new Error(`tests/ tree leaks ${hits.length} private identifier(s):\n${detail}`);
    }
    expect(hits).toHaveLength(0);
  });

  it('no internal RC commit SHA or pre-release tag string is reachable in tracked source', () => {
    // Durable regression guard for the beta.2 scrub: the public tree must never
    // (re)gain an internal release-candidate commit SHA (loaded from the external
    // denylist's commitShas — no literal here) or an `rc.N` pre-release tag string
    // (a structural pattern, no private value). Excludes the scanner's own source
    // (it defines the patterns) + the gitignored denylist + tests fixtures' synthetic
    // values. dist/ is generated and scanned over the artifact separately.
    const fs = require('node:fs') as typeof import('node:fs');
    const cp = require('node:child_process') as typeof import('node:child_process');
    const dl = loadPrivateDenylist(REPO);
    const shaRules = denylistRules({ identifiers: [], commitShas: dl.commitShas });
    const rcTag = new RegExp('\\b(?:v?\\d+\\.\\d+\\.\\d+-)?rc\\.[0-9]+\\b', 'i');
    const tracked = cp.execFileSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const skip = (f: string) => /src\/tools\/content-scan\.ts$|\.xbus-scan-denylist\.json$|\/tests\/|^tests\//.test(f.replace(/\\/g, '/'));
    const hits: string[] = [];
    for (const f of tracked) {
      if (skip(f)) continue;
      let text: string;
      try { text = fs.readFileSync(path.join(REPO, f), 'utf8'); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i]!;
        if (rcTag.test(ln) && !/synthetic|placeholder|fixture|example|e\.g\./i.test(ln)) hits.push(`rc-tag  ${f}:${i + 1}  ${ln.trim().slice(0, 70)}`);
        for (const r of shaRules) if (r.pattern.test(ln)) hits.push(`rc-sha  ${f}:${i + 1}  ${ln.trim().slice(0, 70)}`);
      }
    }
    if (hits.length) throw new Error(`internal RC provenance leaked back into tracked source:\n  ${hits.join('\n  ')}`);
    expect(hits).toHaveLength(0);
  });

  it('the private publication audit FAILS CLOSED when the external denylist is absent', () => {
    // §3: the regression guard skips silently on an ordinary end-user build (no
    // external denylist present) — correct, because the denylist is not shipped.
    // But the PRIVATE PUBLICATION AUDIT must NEVER pass silently: before publishing,
    // the maintainer asserts the denylist is present, so a missing denylist is a
    // hard FAIL (it would otherwise mean "scanned for nothing"). This guard proves
    // the publication-audit contract: requirePublicationDenylist() throws when the
    // denylist resolves empty, and returns the populated denylist otherwise.
    // (It is a no-literal structural check; it never embeds a private value.)
    function requirePublicationDenylist(cwd: string): { identifiers: string[]; commitShas: string[] } {
      const dl = loadPrivateDenylist(cwd);
      if (dl.identifiers.length === 0 && dl.commitShas.length === 0) {
        throw new Error('PUBLICATION AUDIT FAIL-CLOSED: external denylist (.xbus-scan-denylist.json) is absent or empty; refusing to certify a publication scan that checked nothing.');
      }
      return dl;
    }
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    // (a) An empty/denylist-less dir must FAIL CLOSED.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-no-denylist-'));
    expect(() => requirePublicationDenylist(emptyDir)).toThrow(/FAIL-CLOSED/);
    // (b) The real repo (denylist present locally) must pass; on a fresh clone with
    //     no denylist the publication audit is INTENTIONALLY not runnable — only the
    //     maintainer with the gitignored denylist may certify a publication.
    const real = loadPrivateDenylist(REPO);
    if (real.identifiers.length > 0 || real.commitShas.length > 0) {
      expect(() => requirePublicationDenylist(REPO)).not.toThrow();
    }
  });

  it('the scanner SOURCE itself ships no private value (no literal, no reversible char-code payload)', () => {
    // Regression guard for the beta.1→beta.2 finding: content-scan.ts must not embed
    // private identifiers as literals OR as reversible char-code arrays. This guard
    // carries NO private literal of its own — it loads the prohibited values from the
    // EXTERNAL gitignored denylist (when present) and checks structurally otherwise.
    const fs = require('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync(path.join(REPO, 'src', 'tools', 'content-scan.ts'), 'utf8');

    // (a) No char-code obfuscation primitives in the scanner source.
    expect(src, 'scanner must not use char-code obfuscation').not.toMatch(/fromCharCode|fromCodes/);

    // (b) Decode every numeric array literal in the source; none may reverse to a
    //     denylisted token. (Catches any reversible char-code payload regardless of
    //     helper name.) Tokens come from the external denylist — never hard-coded here.
    const denylist = (() => {
      try {
        const { loadPrivateDenylist } = require('../../src/tools/content-scan.js') as typeof import('../../src/tools/content-scan.js');
        const dl = loadPrivateDenylist(REPO);
        return [...dl.identifiers, ...dl.commitShas].filter(Boolean);
      } catch { return [] as string[]; }
    })();
    const decoded: string[] = [];
    for (const m of src.matchAll(/\[((?:\s*\d+\s*,?)+)\]/g)) {
      const nums = m[1]!.split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0 && n < 0x110000);
      if (nums.length >= 4) decoded.push(String.fromCharCode(...nums));
    }
    for (const tok of denylist) {
      expect(decoded.some((d) => d.includes(tok)), 'scanner source must not encode a private value').toBe(false);
      expect(src.includes(tok), 'scanner source must not contain a literal private value').toBe(false);
    }
  });
});
