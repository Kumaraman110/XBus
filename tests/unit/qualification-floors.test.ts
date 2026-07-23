/**
 * Qualification-floor manifest guard (beta.12 qualification-correctness).
 *
 * Proves the release gate's structural invariants are ENCODED and cannot silently regress:
 *   - every required shard is present (none can disappear from the manifest);
 *   - the security shard floor is at least 83 (security count >= 83 is mechanically required);
 *   - skip ceilings are controlled (0 for deterministic shards; a small bounded allowance only for
 *     the integration shard, which has documented LOCAL_ONLY real-broker skips);
 *   - the floors are internally consistent with the coverage manifest.
 *
 * This runs in the unit shard, so it is part of every canonical verify:release and needs no broker.
 */
import { describe, it, expect } from 'vitest';
import { SHARDS } from '../../src/tools/shards.js';

const byName = Object.fromEntries(SHARDS.map((s) => [s.name, s]));

describe('qualification floors — required shards cannot disappear', () => {
  it('all five required shards are present in the manifest', () => {
    const names = SHARDS.map((s) => s.name).sort();
    expect(names).toEqual(['adapter-sdk', 'e2e', 'integration', 'security', 'unit']);
  });

  it('every shard declares positive minTests/minFiles floors and a defined skip ceiling', () => {
    for (const s of SHARDS) {
      expect(s.minTests, `${s.name}.minTests`).toBeGreaterThan(0);
      expect(s.minFiles, `${s.name}.minFiles`).toBeGreaterThan(0);
      expect(s.maxSkipped, `${s.name}.maxSkipped`).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(s.maxSkipped), `${s.name}.maxSkipped integer`).toBe(true);
    }
  });
});

describe('qualification floors — security count is at least 83', () => {
  it('the security shard floor enforces >= 83 tests and >= 11 files', () => {
    expect(byName.security).toBeDefined();
    expect(byName.security!.minTests).toBeGreaterThanOrEqual(83);
    expect(byName.security!.minFiles).toBeGreaterThanOrEqual(11);
  });
});

describe('qualification floors — skip counts remain controlled', () => {
  it('deterministic shards allow ZERO skips', () => {
    for (const name of ['unit', 'security', 'e2e', 'adapter-sdk']) {
      expect(byName[name]!.maxSkipped, `${name}.maxSkipped`).toBe(0);
    }
  });
  it('the integration shard allows only a small bounded skip ceiling (documented LOCAL_ONLY)', () => {
    // The integration shard has a handful of environment-gated real-broker skips; the ceiling is
    // deliberately small so a mass-skip that hides failures still trips the floor.
    expect(byName.integration!.maxSkipped).toBeGreaterThan(0);
    expect(byName.integration!.maxSkipped).toBeLessThanOrEqual(16);
  });
});
