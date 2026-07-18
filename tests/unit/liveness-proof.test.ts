/**
 * Beta.10 Stage 0, Part B — the recycled-PID hardened liveness proof (shared with the beta.9
 * hotfix). Unit-tests classifyLiveness's THREE-verdict truth table via INJECTED seams
 * (readCreationTimeMs / pidAlive / handshakeOk / timeout) so the cases are deterministic — no
 * real PID collision, no slow host, no real broker needed. Covers S0-B-unit, S0-B10 (inconclusive),
 * S0-B11 (round-trip match). The per-caller OPPOSITE fail-closed mapping is exercised in the
 * integration tests (classifyShutdown vs checkSingleton).
 */
import { describe, it, expect } from 'vitest';
import { classifyLiveness } from '../../src/broker/liveness-proof.js';

const PID = 4242;
const RECORDED = 1_700_000_000_000;

describe('classifyLiveness — three-verdict truth table (injected seams)', () => {
  it('alive + creation-time MATCHES recorded → PROVEN_LIVE_BROKER (S0-B11 round-trip)', () => {
    const v = classifyLiveness(PID, RECORDED, 'ep', {
      pidAlive: () => true,
      readCreationTimeMs: () => RECORDED, // real broker re-reads its own start time
    });
    expect(v).toBe('proven_live_broker');
  });

  it('alive + creation-time within tolerance → PROVEN_LIVE_BROKER', () => {
    const v = classifyLiveness(PID, RECORDED, 'ep', {
      pidAlive: () => true,
      readCreationTimeMs: () => RECORDED + 400, // jitter under the default 1000ms tolerance
    });
    expect(v).toBe('proven_live_broker');
  });

  it('alive + creation-time MISMATCHES recorded → PROVEN_DEAD_OR_RECYCLED (the recycled-PID core)', () => {
    const v = classifyLiveness(PID, RECORDED, 'ep', {
      pidAlive: () => true,
      readCreationTimeMs: () => RECORDED + 5_000_000, // a DIFFERENT process now holds the PID
    });
    expect(v).toBe('proven_dead_or_recycled');
  });

  it('pid DEAD → PROVEN_DEAD_OR_RECYCLED (regardless of markers)', () => {
    const v = classifyLiveness(PID, RECORDED, 'ep', {
      pidAlive: () => false,
      readCreationTimeMs: () => { throw new Error('should not be called'); },
    });
    expect(v).toBe('proven_dead_or_recycled');
  });

  it('alive + creation-time UNREADABLE + no handshake available → INCONCLUSIVE (S0-B10)', () => {
    const v = classifyLiveness(PID, RECORDED, 'ep', {
      pidAlive: () => true,
      readCreationTimeMs: () => null, // read failed / timed out
      // no handshakeOk provided → arm 2 unavailable
    });
    expect(v).toBe('inconclusive');
  });

  it('alive + OLD state file (no recorded marker) + no handshake → INCONCLUSIVE (never assume ours)', () => {
    const v = classifyLiveness(PID, null, 'ep', {
      pidAlive: () => true,
      readCreationTimeMs: () => RECORDED, // even if we can read now, no recorded value to compare
    });
    expect(v).toBe('inconclusive');
  });

  it('arm 2: alive + no creation-time BUT handshake completes → PROVEN_LIVE_BROKER', () => {
    const v = classifyLiveness(PID, null, 'ep', {
      pidAlive: () => true,
      readCreationTimeMs: () => null,
      handshakeOk: () => true,
    });
    expect(v).toBe('proven_live_broker');
  });

  it('arm 2: alive + no creation-time + handshake REFUSED (squatter, not our protocol) → PROVEN_DEAD_OR_RECYCLED (S0-B8)', () => {
    const v = classifyLiveness(PID, null, 'ep', {
      pidAlive: () => true,
      readCreationTimeMs: () => null,
      handshakeOk: () => false, // connectable but does not speak our STP
    });
    expect(v).toBe('proven_dead_or_recycled');
  });

  it('arm 2: handshake probe UNAVAILABLE (undefined) + no creation-time → INCONCLUSIVE', () => {
    const v = classifyLiveness(PID, null, 'ep', {
      pidAlive: () => true,
      readCreationTimeMs: () => null,
      handshakeOk: () => undefined,
    });
    expect(v).toBe('inconclusive');
  });

  it('creation-time arm WINS over handshake when both available (positive match)', () => {
    const v = classifyLiveness(PID, RECORDED, 'ep', {
      pidAlive: () => true,
      readCreationTimeMs: () => RECORDED,
      handshakeOk: () => false, // ignored — creation-time already proved life
    });
    expect(v).toBe('proven_live_broker');
  });
});
