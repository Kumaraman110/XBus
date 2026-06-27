/**
 * Enforced shard coverage manifest. verify:release runs the suite in
 * directory shards; this test PROVES the shard set is collectively exhaustive
 * (every tests/**\/*.test.ts file is in exactly one shard) and mutually exclusive
 * (no file in two shards). If someone adds tests/<newdir>/x.test.ts that no shard
 * covers, this fails — closing the gap that let the dead `test:contract` script
 * silently cover nothing.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SHARDS, listAllTestFiles, shardCoverage } from '../../src/tools/shards.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('shard coverage manifest', () => {
  it('every test file is covered by exactly one declared shard', () => {
    const all = listAllTestFiles(REPO);
    expect(all.length).toBeGreaterThan(0);
    const cov = shardCoverage(REPO);
    if (cov.uncovered.length > 0) {
      throw new Error(`test files covered by NO shard (add a shard or fix SHARDS):\n  ${cov.uncovered.join('\n  ')}`);
    }
    if (cov.duplicated.length > 0) {
      throw new Error(`test files covered by MORE THAN ONE shard:\n  ${cov.duplicated.join('\n  ')}`);
    }
    expect(cov.uncovered).toHaveLength(0);
    expect(cov.duplicated).toHaveLength(0);
    expect(cov.coveredCount).toBe(all.length);
  });

  it('the declared shards all point at real directories', () => {
    for (const s of SHARDS) {
      expect(fs.existsSync(path.join(REPO, s.dir)), `shard dir missing: ${s.dir}`).toBe(true);
    }
  });
});
