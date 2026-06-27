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
