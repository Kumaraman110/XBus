/**
 * Test shard manifest. The full suite is run in directory shards to
 * stay within execution limits; this module is the single source of truth for
 * the shard set and proves coverage is exhaustive + non-overlapping. Both the
 * shard-coverage test and `verify:release` import it.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Shard { name: string; dir: string; }

/** Mutually exclusive, collectively exhaustive shards (relative to repo root). */
export const SHARDS: Shard[] = [
  { name: 'unit', dir: 'tests/unit' },
  { name: 'security', dir: 'tests/security' },
  { name: 'integration', dir: 'tests/integration' },
  { name: 'e2e', dir: 'tests/e2e' },
  { name: 'adapter-sdk', dir: 'tests/adapter-sdk' },
];

/** vitest excludes (must match vitest.config.ts). */
const EXCLUDE = [/\/tests\/e2e\/live\//];

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(f); else yield f;
  }
}

/** Every test file vitest would run (tests/**\/*.test.ts minus excludes), as
 *  repo-relative POSIX paths. */
export function listAllTestFiles(repo: string): string[] {
  const out: string[] = [];
  for (const f of walk(path.join(repo, 'tests'))) {
    if (!f.endsWith('.test.ts')) continue;
    const rel = path.relative(repo, f).replace(/\\/g, '/');
    if (EXCLUDE.some((re) => re.test('/' + rel))) continue;
    out.push(rel);
  }
  return out.sort();
}

/** Test files under a shard dir. */
export function listShardFiles(repo: string, shard: Shard): string[] {
  const out: string[] = [];
  for (const f of walk(path.join(repo, shard.dir))) {
    if (!f.endsWith('.test.ts')) continue;
    const rel = path.relative(repo, f).replace(/\\/g, '/');
    if (EXCLUDE.some((re) => re.test('/' + rel))) continue;
    out.push(rel);
  }
  return out.sort();
}

export interface ShardCoverage {
  total: number;
  coveredCount: number;
  uncovered: string[];   // in the suite but in no shard
  duplicated: string[];  // in more than one shard
}

export function shardCoverage(repo: string): ShardCoverage {
  const all = listAllTestFiles(repo);
  const counts = new Map<string, number>();
  for (const s of SHARDS) for (const f of listShardFiles(repo, s)) counts.set(f, (counts.get(f) ?? 0) + 1);
  const uncovered = all.filter((f) => !counts.has(f));
  const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([f]) => f).sort();
  const coveredCount = all.filter((f) => counts.has(f)).length;
  return { total: all.length, coveredCount, uncovered, duplicated };
}
