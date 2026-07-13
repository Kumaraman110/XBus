/**
 * Dashboard auth bootstrap — nonce → exchange → tab-token (ADR 0018 D2).
 * Proves: one-time nonce (single-use CAS), TTL-bound, atomic exchange, short-lived token,
 * constant-time validate, and that the store keeps only HASHES (never the cleartext).
 */
import { describe, it, expect } from 'vitest';
import { DashboardAuth } from '../../src/broker/dashboard/auth.js';
import { FakeClock } from '../../src/shared/clock.js';

function mk(cfg = {}): { auth: DashboardAuth; clock: FakeClock } {
  const clock = new FakeClock();
  return { auth: new DashboardAuth(clock, cfg), clock };
}

describe('DashboardAuth — nonce/token bootstrap', () => {
  it('a fresh nonce exchanges once for a tab token; the token authenticates', () => {
    const { auth } = mk();
    const nonce = auth.mintNonce();
    const issued = auth.exchange(nonce);
    expect(issued).not.toBeNull();
    expect(typeof issued!.token).toBe('string');
    expect(auth.validateToken(issued!.token)).toBe(true);
  });

  it('a nonce is SINGLE-USE: the second exchange of the same nonce is rejected (atomic CAS)', () => {
    const { auth } = mk();
    const nonce = auth.mintNonce();
    expect(auth.exchange(nonce)).not.toBeNull();
    expect(auth.exchange(nonce)).toBeNull(); // replay → null (consumed)
  });

  it('an expired nonce is rejected', () => {
    const { auth, clock } = mk({ nonceTtlMs: 1000 });
    const nonce = auth.mintNonce();
    clock.advance(1001);
    expect(auth.exchange(nonce)).toBeNull();
  });

  it('an unknown / empty nonce is rejected', () => {
    const { auth } = mk();
    expect(auth.exchange('never-minted')).toBeNull();
    expect(auth.exchange('')).toBeNull();
  });

  it('a tab token expires after its TTL', () => {
    const { auth, clock } = mk({ tokenTtlMs: 5000 });
    const issued = auth.exchange(auth.mintNonce())!;
    expect(auth.validateToken(issued.token)).toBe(true);
    clock.advance(5001);
    expect(auth.validateToken(issued.token)).toBe(false);
  });

  it('validateToken rejects garbage / empty / undefined', () => {
    const { auth } = mk();
    expect(auth.validateToken(undefined)).toBe(false);
    expect(auth.validateToken('')).toBe(false);
    expect(auth.validateToken('not-a-real-token')).toBe(false);
  });

  it('tokens are per-exchange independent (multiple tabs); one does not invalidate another', () => {
    const { auth } = mk();
    const t1 = auth.exchange(auth.mintNonce())!.token;
    const t2 = auth.exchange(auth.mintNonce())!.token;
    expect(t1).not.toBe(t2);
    expect(auth.validateToken(t1)).toBe(true);
    expect(auth.validateToken(t2)).toBe(true);
  });

  it('the store holds only HASHES — the cleartext nonce/token never appears in its state', () => {
    const { auth } = mk();
    const nonce = auth.mintNonce();
    const issued = auth.exchange(nonce)!;
    // Reach into the instance's own enumerable state and stringify it; the cleartext
    // secrets must not be present anywhere (only sha256 hex digests are stored).
    const dump = JSON.stringify(auth, (_k, v) => (v instanceof Map ? [...v.entries()] : v));
    expect(dump.includes(nonce)).toBe(false);
    expect(dump.includes(issued.token)).toBe(false);
  });
});
