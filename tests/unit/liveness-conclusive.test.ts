/**
 * Liveness-conclusiveness regression guard (beta.12 qualification-correctness).
 *
 * The clean-machine gate requires the process-creation-time liveness probe to be CONCLUSIVE, and the
 * safety property is that it fails closed (never a false proven-live) when it cannot read. This test
 * pins classifyLiveness()'s conclusiveness contract deterministically (injected creation-time probe,
 * no broker), so a regression that makes a resolvable probe return 'inconclusive' — or, worse, makes
 * an unresolvable probe falsely claim 'proven_live_broker' — is caught in the unit shard.
 */
import { describe, it, expect } from 'vitest';
import { classifyLiveness, type LivenessDeps } from '../../src/broker/liveness-proof.js';

const PID = 4242;
const aliveDeps = (over: Partial<LivenessDeps> = {}): LivenessDeps => ({
  pidAlive: () => true,
  toleranceMs: 1000,
  ...over,
});

describe('classifyLiveness — creation-time probe is CONCLUSIVE when it resolves', () => {
  it('recorded == fresh creation-time (probe resolves, matches) => PROVEN_LIVE, never inconclusive', () => {
    const v = classifyLiveness(PID, 1_000_000, undefined, aliveDeps({ readCreationTimeMs: () => 1_000_000 }));
    expect(v).toBe('proven_live_broker');
  });

  it('recorded != fresh creation-time beyond tolerance (probe resolves, mismatch) => PROVEN_DEAD_OR_RECYCLED, conclusive', () => {
    const v = classifyLiveness(PID, 1_000_000, undefined, aliveDeps({ readCreationTimeMs: () => 2_000_000 }));
    expect(v).toBe('proven_dead_or_recycled');
  });

  it('a dead PID is conclusively proven_dead regardless of creation-time', () => {
    const v = classifyLiveness(PID, 1_000_000, undefined, aliveDeps({ pidAlive: () => false, readCreationTimeMs: () => 1_000_000 }));
    expect(v).toBe('proven_dead_or_recycled');
  });
});

describe('classifyLiveness — fails CLOSED to inconclusive when the probe cannot read (never a false proven-live)', () => {
  it('creation-time unreadable AND no handshake => inconclusive (not a false proven-live)', () => {
    const v = classifyLiveness(PID, 1_000_000, undefined, aliveDeps({ readCreationTimeMs: () => null }));
    expect(v).toBe('inconclusive');
  });

  it('creation-time unreadable but STP handshake succeeds => conclusive proven_live (authoritative arm 2)', () => {
    const v = classifyLiveness(PID, null, 'pipe://x', aliveDeps({ readCreationTimeMs: () => null, handshakeOk: () => true }));
    expect(v).toBe('proven_live_broker');
  });

  it('creation-time unreadable + handshake proves NOT our protocol => conclusive proven_dead_or_recycled', () => {
    const v = classifyLiveness(PID, null, 'pipe://x', aliveDeps({ readCreationTimeMs: () => null, handshakeOk: () => false }));
    expect(v).toBe('proven_dead_or_recycled');
  });

  it('an unresolvable probe NEVER yields a false proven_live_broker (the safety-critical direction)', () => {
    // No creation-time, no handshake, no endpoint — the ONLY safe verdict is inconclusive.
    const v = classifyLiveness(PID, undefined, undefined, aliveDeps({ readCreationTimeMs: () => null }));
    expect(v).not.toBe('proven_live_broker');
    expect(v).toBe('inconclusive');
  });
});
