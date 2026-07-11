/**
 * ensureBroker() — race-safe connect-or-start (beta.4, ADR 0012 Decision 7).
 *
 * The shared entry the MCP server, hooks, CLI, and admin clients use to get a
 * working broker WITHOUT the user running `xbus start`. The state machine:
 *   probe reachable            -> reuse (no spawn)
 *   probe unreachable + acquire -> spawn ONE detached broker, await handshake
 *   contended (lost race)      -> bounded backoff, re-probe, connect (NO 2nd spawn)
 *   incompatible running broker -> degraded, NEVER force-restart
 *   spawn never becomes reachable -> degraded (bounded), never hangs
 *
 * All collaborators (probe, checkSingleton, spawn, sleep) are injected so this is
 * deterministic and never opens a socket or forks a process.
 */
import { describe, it, expect, vi } from 'vitest';
import { ensureBroker, brokerSpawnEnv, type EnsureBrokerDeps } from '../../src/broker/ensure.js';

const ENDPOINT = '\\\\.\\pipe\\xbus-test';
const DATA = '/tmp/xbus-test-data';

/** Build deps with sensible defaults; override per test. Tracks spawn calls. */
function deps(over: Partial<EnsureBrokerDeps> = {}): EnsureBrokerDeps & { spawnCalls: () => number } {
  let spawns = 0;
  const base: EnsureBrokerDeps = {
    dataDir: DATA,
    endpoint: ENDPOINT,
    probe: async () => false,
    checkSingleton: async () => ({ outcome: 'acquired', detail: 'no existing broker' }),
    spawnBroker: async () => { spawns++; },
    verifyCompatible: async () => ({ ok: true }),
    sleep: async () => { /* no real delay */ },
    now: () => 0,
    handshakeTimeoutMs: 3000,
    maxBackoffMs: 100,
    log: () => {},
    ...over,
  };
  return Object.assign(base, { spawnCalls: () => spawns });
}

describe('ensureBroker — reuse path', () => {
  it('a reachable broker is reused; NO spawn, NO singleton check needed', async () => {
    let singletonChecks = 0;
    const d = deps({
      probe: async () => true, // reachable on first probe
      checkSingleton: async () => { singletonChecks++; return { outcome: 'already_running', detail: '' }; },
    });
    const r = await ensureBroker(d);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.isRunning).toBe(true); expect(r.launched).toBe(false); expect(r.endpoint).toBe(ENDPOINT); }
    expect(d.spawnCalls()).toBe(0);
    expect(singletonChecks).toBe(0); // reuse short-circuits before the singleton arbiter
  });
});

describe('ensureBroker — acquire + spawn path', () => {
  it('unreachable + acquired -> spawns ONE broker, then connects after it becomes reachable', async () => {
    let probeCount = 0;
    const d = deps({
      // unreachable initially; reachable AFTER the spawn (3rd probe).
      probe: async () => { probeCount++; return probeCount >= 3; },
      checkSingleton: async () => ({ outcome: 'acquired', detail: 'acquiring' }),
    });
    const r = await ensureBroker(d);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.launched).toBe(true); expect(r.isRunning).toBe(true); }
    expect(d.spawnCalls()).toBe(1); // exactly one
  });

  it('stale_cleared is treated like acquire (spawns)', async () => {
    let probeCount = 0;
    const d = deps({
      probe: async () => { probeCount++; return probeCount >= 2; },
      checkSingleton: async () => ({ outcome: 'stale_cleared', detail: 'dead pid' }),
    });
    const r = await ensureBroker(d);
    expect(r.ok).toBe(true);
    expect(d.spawnCalls()).toBe(1);
  });
});

describe('ensureBroker — contended (lost race) path', () => {
  it('contended -> does NOT spawn; backs off, re-probes, connects to the winner', async () => {
    let probeCount = 0;
    const sleeps: number[] = [];
    const d = deps({
      // not reachable on the first probe; the WINNER becomes reachable on a later probe.
      probe: async () => { probeCount++; return probeCount >= 3; },
      checkSingleton: async () => ({ outcome: 'contended', detail: 'another broker is starting' }),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const r = await ensureBroker(d);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.launched).toBe(false); expect(r.isRunning).toBe(true); }
    expect(d.spawnCalls()).toBe(0); // the loser must NOT start a second broker
    expect(sleeps.length).toBeGreaterThan(0); // it backed off
    // backoff is bounded by maxBackoffMs
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(100);
  });
});

describe('ensureBroker — incompatible broker', () => {
  it('a reachable but INCOMPATIBLE broker is surfaced degraded, NEVER force-restarted', async () => {
    const d = deps({
      probe: async () => true,
      verifyCompatible: async () => ({ ok: false, reason: 'restart_broker', detail: 'broker schema older' }),
    });
    const r = await ensureBroker(d);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toMatch(/incompat|restart|schema/i); expect(r.degraded).toBe(true); }
    expect(d.spawnCalls()).toBe(0); // must not kill/replace it
  });
});

describe('ensureBroker — failure handling', () => {
  it('a spawned broker that never becomes reachable -> degraded (bounded), not a hang', async () => {
    const d = deps({
      probe: async () => false, // never reachable, even after spawn
      checkSingleton: async () => ({ outcome: 'acquired', detail: '' }),
      handshakeTimeoutMs: 50,
      now: (() => { let t = 0; return () => (t += 20); })(), // clock advances each call
    });
    const r = await ensureBroker(d);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.degraded).toBe(true); expect(r.reason).toMatch(/timeout|unreachable|start/i); }
    expect(d.spawnCalls()).toBe(1); // it tried once
  });

  it('a spawn that throws -> degraded, never throws out of ensureBroker', async () => {
    const d = deps({
      probe: async () => false,
      checkSingleton: async () => ({ outcome: 'acquired', detail: '' }),
      spawnBroker: async () => { throw new Error('EACCES'); },
    });
    const r = await ensureBroker(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.degraded).toBe(true);
  });

  it('NEVER throws — a degraded result is always returned (hook silent-degrade contract)', async () => {
    const d = deps({
      probe: async () => { throw new Error('boom'); },
      checkSingleton: async () => { throw new Error('boom'); },
    });
    await expect(ensureBroker(d)).resolves.toBeDefined();
  });
});

describe('brokerSpawnEnv — detached-broker environment (final-review: least-privilege scrub)', () => {
  it('scrubs XBUS_ROOT_SECRET from the inherited env (never propagate a secret via env)', () => {
    const parent = { XBUS_ROOT_SECRET: 'deadbeef'.repeat(8), PATH: '/usr/bin', USERNAME: 'alice' } as NodeJS.ProcessEnv;
    const env = brokerSpawnEnv(parent, '/data/dir');
    expect(env.XBUS_ROOT_SECRET).toBeUndefined();
  });

  it('PRESERVES the OS-critical vars the broker needs (endpoint/crypto/ACL) — NOT a narrow allowlist', () => {
    // A minimal allowlist would break startup: transport.ts derives the per-user pipe
    // from USERNAME, and Node crypto + icacls need SystemRoot/TEMP/PATH on Windows.
    const parent = {
      USERNAME: 'alice', PATH: '/usr/bin:/bin', SystemRoot: 'C:\\WINDOWS',
      TEMP: 'C:\\Temp', windir: 'C:\\WINDOWS', LOCALE: 'en_US',
    } as NodeJS.ProcessEnv;
    const env = brokerSpawnEnv(parent, '/data/dir');
    expect(env.USERNAME).toBe('alice');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.SystemRoot).toBe('C:\\WINDOWS');
    expect(env.TEMP).toBe('C:\\Temp');
    expect(env.windir).toBe('C:\\WINDOWS');
  });

  it('pins XBUS_DATA_DIR to the requested dir and does NOT mutate the caller env', () => {
    const parent = { XBUS_DATA_DIR: '/old', XBUS_ROOT_SECRET: 'x', PATH: '/p' } as NodeJS.ProcessEnv;
    const env = brokerSpawnEnv(parent, '/new/data');
    expect(env.XBUS_DATA_DIR).toBe('/new/data');
    // caller's object is untouched (fresh copy returned)
    expect(parent.XBUS_DATA_DIR).toBe('/old');
    expect(parent.XBUS_ROOT_SECRET).toBe('x');
  });
});
