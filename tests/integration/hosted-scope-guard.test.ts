/**
 * BETA.10 hosted-CI scope DRIFT GUARD (Option A). Fails when any file in tests/integration/ is not
 * classified in tests/integration-scope.ts — so a NEW integration test cannot silently fall into an
 * undefined category (which, under the fail-closed hosted include-list, would silently drop it from
 * the hosted lane with no signal). This is a pure fs walk: no broker, no dist, no network — itself
 * HOSTED_SAFE, so it runs on the hosted lane and catches drift there too.
 *
 * Intentionally simple + test-only (no orchestration framework): read the dir, diff against the two
 * classification lists.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTED_SAFE_INTEGRATION, LOCAL_ONLY_INTEGRATION } from '../integration-scope.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** All *.test.ts basenames physically present in tests/integration/ (excludes this guard's own dir walk of nothing else). */
function integrationTestFiles(): string[] {
  return fs.readdirSync(HERE).filter((f) => f.endsWith('.test.ts')).sort();
}

describe('hosted-CI scope drift guard — every integration test is classified exactly once', () => {
  const hosted = new Set(HOSTED_SAFE_INTEGRATION);
  const local = new Set(LOCAL_ONLY_INTEGRATION.map((e) => e.file));

  it('the two classification lists do not overlap', () => {
    const both = [...hosted].filter((f) => local.has(f));
    expect(both, `files classified BOTH hosted-safe and local-only: ${both.join(', ')}`).toEqual([]);
  });

  it('every tests/integration/*.test.ts is classified (no UNCLASSIFIED file — fail-closed drift guard)', () => {
    const known = new Set<string>([...hosted, ...local]);
    // The guard file itself must be classified too (it IS hosted-safe); include it in the expectation.
    const unclassified = integrationTestFiles().filter((f) => !known.has(f));
    expect(
      unclassified,
      `UNCLASSIFIED integration test(s) — add to tests/integration-scope.ts (HOSTED_SAFE_INTEGRATION ` +
      `or LOCAL_ONLY_INTEGRATION with a reason): ${unclassified.join(', ')}`,
    ).toEqual([]);
  });

  it('no classification entry names a file that no longer exists (stale roster)', () => {
    const present = new Set(integrationTestFiles());
    const stale = [...hosted, ...local].filter((f) => !present.has(f));
    expect(stale, `classification names missing file(s) — remove from integration-scope.ts: ${stale.join(', ')}`).toEqual([]);
  });

  it('this guard is itself HOSTED_SAFE (so it runs on the hosted lane and catches drift there)', () => {
    expect(hosted.has('hosted-scope-guard.test.ts'), 'the guard test must be in HOSTED_SAFE_INTEGRATION').toBe(true);
  });
});
