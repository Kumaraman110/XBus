import { describe, it, expect } from 'vitest';
import {
  dispositionForError, nextBackoffMs, attemptsExhausted, DEFAULT_BACKOFF, WAITING_REASONS, emptyCounters,
} from '../../src/broker/retry.js';
import {
  acceptanceExpiryMs, responseDeadlineMs, retentionCutoffMs, isExpired, DEFAULT_TIME_DOMAINS,
} from '../../src/broker/deadlines.js';
import { XBusErrorCode } from '../../src/protocol/errors.js';

describe('retry taxonomy', () => {
  it('classifies permanent errors as non-retryable', () => {
    for (const c of [XBusErrorCode.UNKNOWN_RECIPIENT, XBusErrorCode.BLOCKED, XBusErrorCode.PROTOCOL_VIOLATION, XBusErrorCode.VERSION_INCOMPATIBLE, XBusErrorCode.FORBIDDEN_ROLE, XBusErrorCode.INJECTION_NOT_FOUND, XBusErrorCode.MESSAGE_EXPIRED]) {
      expect(dispositionForError(c)).toBe('permanent');
    }
  });
  it('classifies transient errors as retryable', () => {
    for (const c of [XBusErrorCode.BROKER_UNAVAILABLE, XBusErrorCode.DATABASE_ERROR, XBusErrorCode.RATE_LIMITED]) {
      expect(dispositionForError(c)).toBe('transient');
    }
  });
  it('fails closed: unknown codes are permanent (no retry storm)', () => {
    expect(dispositionForError('XBUS_SOMETHING_NEW')).toBe('permanent');
  });
  it('waiting reasons are a distinct, fixed set', () => {
    expect(WAITING_REASONS).toContain('paused');
    expect(WAITING_REASONS).toContain('waiting_for_human_checkpoint');
  });
  it('per-category counters start at zero', () => {
    expect(emptyCounters()).toEqual({ transport: 0, contextInjection: 0, ackTimeout: 0, replyDelivery: 0 });
  });
});

describe('backoff (deterministic with seeded rng)', () => {
  it('full jitter stays within [0, ceil] and ceil grows then caps', () => {
    const cfg = DEFAULT_BACKOFF;
    // rng=1 gives the ceiling (minus floor); rng=0 gives 0.
    expect(nextBackoffMs(0, cfg, () => 0)).toBe(0);
    const d0 = nextBackoffMs(0, cfg, () => 0.999999);
    expect(d0).toBeLessThanOrEqual(cfg.initialDelayMs);
    const d3 = nextBackoffMs(3, cfg, () => 0.999999);
    expect(d3).toBeLessThanOrEqual(cfg.maxDelayMs);
    // ceiling caps at maxDelay for large attempts
    const dBig = nextBackoffMs(20, cfg, () => 0.999999);
    expect(dBig).toBeLessThanOrEqual(cfg.maxDelayMs);
  });
  it('is reproducible for a fixed rng sequence', () => {
    let i = 0;
    const seq = [0.1, 0.5, 0.9];
    const rng = () => seq[i++ % seq.length]!;
    const a = [0, 1, 2].map((n) => nextBackoffMs(n, DEFAULT_BACKOFF, rng));
    i = 0;
    const b = [0, 1, 2].map((n) => nextBackoffMs(n, DEFAULT_BACKOFF, rng));
    expect(a).toEqual(b);
  });
  it('attemptsExhausted at maxAttempts', () => {
    expect(attemptsExhausted(DEFAULT_BACKOFF.maxAttempts, DEFAULT_BACKOFF)).toBe(true);
    expect(attemptsExhausted(DEFAULT_BACKOFF.maxAttempts - 1, DEFAULT_BACKOFF)).toBe(false);
  });
});

describe('three time domains', () => {
  const d = DEFAULT_TIME_DOMAINS;
  const created = 1_700_000_000_000;

  it('acceptance expiry: waiting does NOT burn TTL by default', () => {
    const pausedFor = 5 * 60 * 60_000; // paused 5h
    const withWait = acceptanceExpiryMs(created, pausedFor, d);
    const noWait = acceptanceExpiryMs(created, 0, d);
    expect(withWait).toBe(noWait + pausedFor); // pause pushed the deadline out
  });

  it('acceptance expiry: waiting CAN count when policy says so', () => {
    const d2 = { ...d, waitingCountsTowardAcceptance: true };
    expect(acceptanceExpiryMs(created, 999, d2)).toBe(created + d.acceptanceTtlMs); // ignores pause accum
  });

  it('response deadline anchored at injection, independent of acceptance TTL', () => {
    const injectedAt = created + 20 * 60 * 60_000; // injected 20h after create
    expect(responseDeadlineMs(injectedAt, d)).toBe(injectedAt + d.responseDeadlineMs);
  });

  it('retention cutoff is now - retention', () => {
    const now = created + 100;
    expect(retentionCutoffMs(now, d)).toBe(now - d.retentionMs);
  });

  it('isExpired needs BOTH wall + monotonic when monotonic is provided (clock-jump safe)', () => {
    const deadline = created + 1000;
    // wall says passed, but monotonic budget not yet elapsed -> NOT expired
    expect(isExpired(deadline, created + 2000, { monoElapsedMs: 500, monoBudgetMs: 1000 })).toBe(false);
    // both passed -> expired
    expect(isExpired(deadline, created + 2000, { monoElapsedMs: 1500, monoBudgetMs: 1000 })).toBe(true);
    // wall not passed -> not expired regardless
    expect(isExpired(deadline, created + 500)).toBe(false);
  });
});
