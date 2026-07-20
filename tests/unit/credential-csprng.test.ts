/**
 * beta.9.1 credential hardening — the CSPRNG owner-secret primitive.
 *
 * The reclaim owner secret is an IDENTITY authenticator: presenting it reclaims a durable
 * name + its entire canonical inbox. The prior derivation minted it as
 *   sha256(`owner-secret:${brokerInstanceId}:${fencingCounter}:${nowMs()}`)
 * — a deterministic function of a PUBLIC broker id (disclosed in every hello_ack), a monotonic
 * counter, and wall-clock ms, so an observer could reconstruct the preimage and guess it. This
 * suite proves the replacement draws from Node's CSPRNG, that the client representation +
 * stored-hash verification contract are preserved (already-issued secrets keep verifying), that
 * the deterministic seam is test-only, and that production can never fall back to predictable
 * entropy. Maps 1:1 to the beta.9.1 8-point test matrix (see each `it` tag).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, cryptoCredentialSecret, CREDENTIAL_SECRET_BYTES, type SessionAuthority } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let clock: FakeClock;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-cred-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

let storeSeed = 0;
function makeStore(randomFn?: () => string): BrokerStore {
  // brokerInstanceId is fixed + a deterministic clock is used — under the OLD derivation these
  // would make the secret predictable; the CSPRNG mint must be unpredictable regardless. Each
  // store gets a DISTINCT IdGen seed so two stores over the same DB never collide on generated
  // ids (e.g. aliases.alias_id) — an unrelated harness concern, not part of what's under test.
  return new BrokerStore(db, clock, new SeqIdGen(`m${++storeSeed}`), 'fixed-broker-id', randomFn);
}
function reg(store: BrokerStore, over: Partial<Parameters<BrokerStore['register']>[0]> = {}): SessionAuthority {
  const s = over.sessionId ?? sid();
  return store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...over });
}
/** The store's private stored-secret hash contract, mirrored here for verification tests. */
function ownerHash(secret: string): string {
  return createHash('sha256').update(`owner:${secret}`, 'utf8').digest('hex');
}
function storedHash(db: SqliteDriver, normalizedName: string): string | null {
  return (db.prepare(`SELECT owner_secret_hash AS h FROM name_ownership WHERE normalized_name=?`).get(normalizedName) as { h: string | null } | undefined)?.h ?? null;
}

describe('beta.9.1 credential CSPRNG — production helper', () => {
  it('[1] generated credential has the expected length + hex encoding', () => {
    const s = cryptoCredentialSecret();
    expect(typeof s).toBe('string');
    expect(s).toHaveLength(CREDENTIAL_SECRET_BYTES * 2); // 32 bytes → 64 hex chars
    expect(s).toMatch(/^[0-9a-f]+$/); // lowercase hex only
  });

  it('[2] separate + high-volume parallel calls do not collide (CSPRNG uniqueness)', async () => {
    const N = 5000;
    const seen = new Set<string>();
    for (let i = 0; i < N; i++) seen.add(cryptoCredentialSecret());
    expect(seen.size).toBe(N); // zero collisions across 5k sequential draws
    // "parallel" in a single-threaded runtime = concurrently-scheduled promises; still unique.
    const concurrent = await Promise.all(Array.from({ length: 1000 }, async () => cryptoCredentialSecret()));
    expect(new Set(concurrent).size).toBe(1000);
  });

  it('[5] production default draws from a cryptographic source (not the deterministic derivation)', () => {
    // Distinct-and-64-hex alone is NOT enough: the OLD sha256(brokerInstanceId:counter:nowMs)
    // scheme ALSO produced distinct 64-hex values across mints (the counter incremented). To
    // actually distinguish CSPRNG from the weak scheme, reconstruct what the old derivation
    // WOULD have emitted for this store (fixed broker id 'fixed-broker-id', frozen FakeClock)
    // across the plausible counter range, and assert the real secrets match NONE of them.
    const store = makeStore(); // NO injected seam → production default
    const nowMs = clock.nowMs();
    const oldScheme = new Set<string>();
    for (let counter = 0; counter <= 10; counter++) {
      for (const t of [nowMs - 1, nowMs, nowMs + 1]) {
        oldScheme.add(createHash('sha256').update(`owner-secret:fixed-broker-id:${counter}:${t}`, 'utf8').digest('hex'));
      }
    }
    const a = reg(store, { requestedSessionName: 'alpha' }).ownerSecret!;
    const b = reg(store, { requestedSessionName: 'bravo' }).ownerSecret!;
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
    expect(b).toHaveLength(64);
    // The load-bearing assertion: neither real secret is any value the deterministic scheme
    // could have produced → this test FAILS if production regressed to the old derivation.
    expect(oldScheme.has(a)).toBe(false);
    expect(oldScheme.has(b)).toBe(false);
  });

  it('[6] timestamp + broker id + counter are NOT sufficient to reconstruct the secret', () => {
    // Reconstruct the OLD preimage from the (attacker-knowable) public inputs and confirm the
    // real secret does NOT equal any hash the old scheme could have produced around this mint.
    const store = makeStore();
    const nowMs = clock.nowMs();
    const real = reg(store, { requestedSessionName: 'charlie' }).ownerSecret!;
    for (const counter of [0, 1, 2, 3, 4, 5]) {
      for (const t of [nowMs - 1, nowMs, nowMs + 1]) {
        const guessed = createHash('sha256').update(`owner-secret:fixed-broker-id:${counter}:${t}`, 'utf8').digest('hex');
        expect(real).not.toBe(guessed);
      }
    }
  });

  it('[7] a test-injected deterministic seam CANNOT alter the production default', () => {
    // An injected store yields the injected value; a DEFAULT store (no seam) still yields
    // CSPRNG output. Injection is strictly local to the store instance it was passed to.
    const injected = makeStore(() => 'deterministic-test-secret');
    expect(reg(injected, { requestedSessionName: 'delta' }).ownerSecret).toBe('deterministic-test-secret');
    const prod = makeStore();
    const p = reg(prod, { requestedSessionName: 'echo' }).ownerSecret!;
    expect(p).not.toBe('deterministic-test-secret');
    expect(p).toMatch(/^[0-9a-f]{64}$/);
    // And the module-level production function itself is unaffected by any injection.
    expect(cryptoCredentialSecret()).not.toBe('deterministic-test-secret');
  });
});

describe('beta.9.1 credential CSPRNG — stored-secret + verification compatibility', () => {
  it('[3] a secret minted under the NEW scheme round-trips: stored hash == hashSecret(plaintext)', () => {
    const store = makeStore();
    const awarded = reg(store, { requestedSessionName: 'foxtrot' });
    const secret = awarded.ownerSecret!;
    expect(storedHash(db, 'foxtrot')).toBe(ownerHash(secret)); // persisted artifact is the sha256('owner:'+s) — contract intact
  });

  it('[3b] an already-issued (pre-hardening) stored hash still verifies + reclaims', () => {
    // Simulate a secret that was handed out by an OLD broker: its plaintext is a legacy
    // sha256-hex string, and the DB holds hashSecret(legacyPlaintext). The NEW code path must
    // still accept it on reclaim — hashSecret is unchanged, so verification is unaffected.
    const sidA = sid();
    const store = makeStore();
    const a = reg(store, { sessionId: sidA, requestedSessionName: 'golf' });
    const legacyPlaintext = createHash('sha256').update('owner-secret:old-broker:1:1700000000000', 'utf8').digest('hex');
    // Overwrite the stored hash to what an OLD-minted secret would have produced.
    db.prepare(`UPDATE name_ownership SET owner_secret_hash=? WHERE normalized_name='golf'`).run(ownerHash(legacyPlaintext));
    // Predecessor goes away, successor reclaims with the legacy plaintext.
    db.prepare(`UPDATE sessions SET state='disconnected' WHERE session_id=?`).run(sidA);
    db.prepare(`UPDATE component_instances SET state='closed' WHERE session_id=?`).run(sidA);
    const b = reg(store, { sessionId: sid(), requestedSessionName: 'golf', ownerSecret: legacyPlaintext });
    expect(b.awardedSessionName).toBe('golf'); // legacy secret still reclaims
    expect(b.logicalIdentityId).toBe(a.logicalIdentityId);
  });

  it('[4] incorrect + malformed credentials FAIL to reclaim (fail-closed)', () => {
    const sidA = sid();
    const store = makeStore();
    reg(store, { sessionId: sidA, requestedSessionName: 'hotel' });
    db.prepare(`UPDATE sessions SET state='disconnected' WHERE session_id=?`).run(sidA);
    db.prepare(`UPDATE component_instances SET state='closed' WHERE session_id=?`).run(sidA);
    for (const bad of ['', 'not-the-secret', 'x'.repeat(64), '00'.repeat(32)]) {
      const attempt = reg(store, { sessionId: sid(), requestedSessionName: 'hotel', ownerSecret: bad });
      // A wrong/malformed secret NEVER reclaims: the caller falls to the beta.7 taken→pending
      // path and gets NO fresh ownerSecret for the protected name.
      expect(attempt.logicalIdentityId).not.toBe(undefined);
      expect(attempt.awardedSessionName == null || attempt.sessionNameState !== 'active').toBe(true);
    }
  });

  it('[8] failure behavior is explicit: a store built with the default seam never yields empty/short entropy', () => {
    // Guards against a silent fallback (e.g. a seam returning '' / undefined). The production
    // default always produces a full-length hex secret; there is no code path to a weak value.
    const store = makeStore();
    for (let i = 0; i < 50; i++) {
      const s = reg(store, { requestedSessionName: `svc-${i}` }).ownerSecret!;
      expect(s).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
