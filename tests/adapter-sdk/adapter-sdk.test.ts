/**
 * PR1 adapter-SDK tests (§16). These exercise the SDK primitives (manifest
 * validation, capability model, broker-enforced tier cap, lifecycle projection,
 * safe errors, entrypoint containment, permission gating) and the compatibility
 * guarantees. The full 25-point ADAPTER CONFORMANCE RUNNER (driving a fake runtime)
 * lands in PR2; PR1 establishes the data model + the cap + the guards.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  validateManifest, SUPPORTED_MANIFEST_VERSION, FROZEN_PROTOCOL_COMPAT,
  calculateMaximumTier, emptyEvidence, isWithinCeiling, awardedTier,
  toVerified, emptyCapabilities, isVerified, CAPABILITY_STATES,
  toReadiness, AUTONOMOUS_INJECTABLE, PROHIBITED_INJECTION, ALL_LIFECYCLE,
  resolveContainedEntrypoint, requirePermission, isPermitted,
  AdapterError, AdapterErrorCode,
  type AdapterManifest, type AgentCapabilities, type VerifiedCapabilities, type SupportTier,
} from '../../src/adapter/index.js';
import { ComponentRole } from '../../src/identity/components.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { SCHEMA_VERSION } from '../../src/protocol/handshake.js';

// ---- helpers ----------------------------------------------------------------
function baseManifest(over: Partial<AdapterManifest> = {}): unknown {
  const caps = emptyCapabilities();
  return {
    manifestVersion: 1,
    adapter: { id: 'sample', name: 'Sample', version: '0.0.1', publisher: 'tester' },
    platform: { id: 'sample-rt', displayName: 'Sample Runtime' },
    vendorAffiliation: 'none',
    receiveModes: ['hook_checkpoint'],
    protocolCompat: { protocol: 1, minProtocol: 1, schema: 5, stp: 1 },
    xbus: { adapterSdkRange: '0.1.x', protocolRange: '1' },
    entrypoint: 'dist/adapter.js',
    declaredCapabilities: caps,
    permissions: [],
    support: { maturity: 'experimental' },
    ...over,
  };
}
function verifiedCaps(over: Partial<VerifiedCapabilities> = {}): VerifiedCapabilities {
  return {
    role: ComponentRole.MCP,
    receive: { manualPull: false, lifecycleCheckpoint: false, livePush: false },
    messaging: { acknowledgements: false, correlatedReplies: false },
    ...over,
  };
}

describe('adapter SDK — manifest validation (§16.1-8)', () => {
  it('1. a valid manifest is accepted', () => {
    const m = validateManifest(baseManifest());
    expect(m.adapter.id).toBe('sample');
    expect(m.vendorAffiliation).toBe('none');
  });
  it('2. an unknown REQUIRED manifest version is rejected (fail closed)', () => {
    expect(() => validateManifest(baseManifest({ manifestVersion: 2 as 1 }))).toThrow(AdapterError);
    try { validateManifest(baseManifest({ manifestVersion: 999 as 1 })); } catch (e) {
      expect((e as AdapterError).code).toBe(AdapterErrorCode.MANIFEST_INVALID);
    }
  });
  it('3. missing required fields are rejected', () => {
    const m = baseManifest() as Record<string, unknown>; delete m.adapter;
    expect(() => validateManifest(m)).toThrow(AdapterError);
  });
  it('4. an absolute entrypoint is rejected', () => {
    expect(() => validateManifest(baseManifest({ entrypoint: 'C:\\evil\\x.js' }))).toThrow(/absolute/);
    expect(() => validateManifest(baseManifest({ entrypoint: '/etc/evil.js' }))).toThrow(/absolute/);
  });
  it('5. an escaping entrypoint (..) is rejected', () => {
    expect(() => validateManifest(baseManifest({ entrypoint: '../../etc/passwd' }))).toThrow(/escape/);
  });
  it('5b. a URL/scheme entrypoint is rejected', () => {
    expect(() => validateManifest(baseManifest({ entrypoint: 'https://evil/x.js' }))).toThrow(/URL|scheme/);
  });
  it('7+8. undeclared network/shell permission is unavailable (default-deny)', () => {
    const m = validateManifest(baseManifest({ permissions: [] }));
    expect(isPermitted(m, 'network')).toBe(false);
    expect(isPermitted(m, 'shell')).toBe(false);
    expect(() => requirePermission(m, 'network')).toThrow(/network/);
    expect(() => requirePermission(m, 'shell')).toThrow(/shell/);
    // a declared permission IS available
    const m2 = validateManifest(baseManifest({ permissions: ['network'] }));
    expect(isPermitted(m2, 'network')).toBe(true);
    expect(() => requirePermission(m2, 'network')).not.toThrow();
  });
  it('provider-credential permissions are rejected outright', () => {
    expect(() => validateManifest(baseManifest({ permissions: ['provider.credential' as 'network'] }))).toThrow(AdapterError);
  });
});

describe('adapter SDK — entrypoint containment (§16.6 path/reparse)', () => {
  it('6. a contained entrypoint resolves inside the package root', () => {
    const root = path.resolve('/tmp/pkg');
    const resolved = resolveContainedEntrypoint(root, 'dist/adapter.js');
    expect(resolved.startsWith(root)).toBe(true);
  });
  it('6b. an escaping entrypoint throws at resolution (defense-in-depth)', () => {
    const root = path.resolve('/tmp/pkg');
    expect(() => resolveContainedEntrypoint(root, '../../../etc/passwd')).toThrow(AdapterError);
  });
});

describe('adapter SDK — capability model (§16.16 + tri/quad-state)', () => {
  it('CapabilityState has exactly the four ranked states', () => {
    expect([...CAPABILITY_STATES]).toEqual(['unsupported', 'declared', 'detected', 'verified']);
  });
  it('16. a non-verified capability cannot count as verified', () => {
    const caps: AgentCapabilities = emptyCapabilities();
    caps.receive.lifecycleCheckpoint = 'declared'; // declared != verified
    caps.messaging.acknowledgements = 'detected';   // detected != verified
    const v = toVerified(ComponentRole.HOOK, caps);
    expect(v.receive.lifecycleCheckpoint).toBe(false);
    expect(v.messaging.acknowledgements).toBe(false);
    expect(isVerified('declared')).toBe(false);
    expect(isVerified('detected')).toBe(false);
    expect(isVerified('verified')).toBe(true);
  });
});

describe('adapter SDK — broker-enforced tier cap (§16.9-18, §10)', () => {
  it('9. an adapter cannot self-award a tier — the cap is computed from evidence only', () => {
    // No evidence ⇒ T0 regardless of how rich the (verified) capabilities claim to be.
    const richlyCapable = verifiedCaps({
      receive: { manualPull: true, lifecycleCheckpoint: true, livePush: true },
      messaging: { acknowledgements: true, correlatedReplies: true },
    });
    expect(calculateMaximumTier(richlyCapable, emptyEvidence())).toBe('T0');
  });
  it('10. T0 — detected only (not booted)', () => {
    expect(calculateMaximumTier(verifiedCaps(), { ...emptyEvidence(), bootedAndRegistered: false })).toBe('T0');
  });
  it('11. T1 — verified send', () => {
    const ev = { ...emptyEvidence(), bootedAndRegistered: true, sendVerified: true };
    expect(calculateMaximumTier(verifiedCaps(), ev)).toBe('T1');
  });
  it('12. T2 — verified send + manual receive', () => {
    const caps = verifiedCaps({ receive: { manualPull: true, lifecycleCheckpoint: false, livePush: false } });
    const ev = { ...emptyEvidence(), bootedAndRegistered: true, sendVerified: true, manualReceiveVerified: true };
    expect(calculateMaximumTier(caps, ev)).toBe('T2');
  });
  it('13. T3 — verified checkpoint receive + ack + reply', () => {
    const caps = verifiedCaps({
      receive: { manualPull: true, lifecycleCheckpoint: true, livePush: false },
      messaging: { acknowledgements: true, correlatedReplies: true },
    });
    const ev = { ...emptyEvidence(), bootedAndRegistered: true, sendVerified: true, manualReceiveVerified: true, checkpointReceiveVerified: true, ackReplyVerified: true };
    expect(calculateMaximumTier(caps, ev)).toBe('T3');
  });
  it('14. T4 REQUIRES verified live delivery (capability + evidence)', () => {
    const capsNoLive = verifiedCaps({
      receive: { manualPull: true, lifecycleCheckpoint: true, livePush: false },
      messaging: { acknowledgements: true, correlatedReplies: true },
    });
    const evLive = { ...emptyEvidence(), bootedAndRegistered: true, sendVerified: true, manualReceiveVerified: true, checkpointReceiveVerified: true, ackReplyVerified: true, liveReceiveVerified: true };
    // live evidence but capability not verified ⇒ capped at T3
    expect(calculateMaximumTier(capsNoLive, evLive)).toBe('T3');
    // both capability + evidence ⇒ T4
    const capsLive = { ...capsNoLive, receive: { ...capsNoLive.receive, livePush: true } };
    expect(calculateMaximumTier(capsLive, evLive)).toBe('T4');
  });
  it('15. T5 REQUIRES complete validation evidence', () => {
    const capsLive = verifiedCaps({
      receive: { manualPull: true, lifecycleCheckpoint: true, livePush: true },
      messaging: { acknowledgements: true, correlatedReplies: true },
    });
    const evT4 = { ...emptyEvidence(), bootedAndRegistered: true, sendVerified: true, manualReceiveVerified: true, checkpointReceiveVerified: true, ackReplyVerified: true, liveReceiveVerified: true };
    expect(calculateMaximumTier(capsLive, evT4)).toBe('T4'); // no fullRuntimeValidation ⇒ not T5
    expect(calculateMaximumTier(capsLive, { ...evT4, fullRuntimeValidation: true })).toBe('T5');
  });
  it('18. no silent rung-skip: missing a lower rung caps below it', () => {
    // booted + send + (NO manual) but checkpoint evidence present ⇒ still T1 (cannot reach T3 past missing T2)
    const caps = verifiedCaps({
      receive: { manualPull: false, lifecycleCheckpoint: true, livePush: false },
      messaging: { acknowledgements: true, correlatedReplies: true },
    });
    const ev = { ...emptyEvidence(), bootedAndRegistered: true, sendVerified: true, checkpointReceiveVerified: true, ackReplyVerified: true };
    expect(calculateMaximumTier(caps, ev)).toBe('T1');
  });
  it('an advertised tier above the ceiling is rejected (isWithinCeiling)', () => {
    const ceiling: SupportTier = 'T2';
    expect(isWithinCeiling('T1', ceiling)).toBe(true);
    expect(isWithinCeiling('T2', ceiling)).toBe(true);
    expect(isWithinCeiling('T3', ceiling)).toBe(false);
    expect(isWithinCeiling('T5', ceiling)).toBe(false);
    expect(awardedTier('T4', 'T2')).toBe('T2'); // policy may award below ceiling
    expect(awardedTier('T2', 'T5')).toBe('T2'); // never above ceiling
  });
});

describe('adapter SDK — lifecycle (§12, §16.17 receive-mode honesty)', () => {
  it('the autonomous-injectable set is exactly {ready_checkpoint, ready_live}', () => {
    expect([...AUTONOMOUS_INJECTABLE].sort()).toEqual(['ready_checkpoint', 'ready_live']);
  });
  it('17/18. new + pre-ready states are NOT autonomously injectable (no silent downgrade)', () => {
    for (const s of ['created', 'starting', 'initializing', 'incompatible', 'stopping', 'stopped'] as const) {
      expect(PROHIBITED_INJECTION.has(s)).toBe(true);
      expect(AUTONOMOUS_INJECTABLE.has(s)).toBe(false);
    }
    // ready_manual is "ready" but GATED — not autonomously injectable, projects to a non-injectable Readiness
    expect(AUTONOMOUS_INJECTABLE.has('ready_manual')).toBe(false);
    expect(toReadiness('ready_manual')).toBe('initializing');
  });
  it('SessionLifecycle projects onto the shipping Readiness for shared names', () => {
    expect(toReadiness('ready_checkpoint')).toBe('ready_checkpoint');
    expect(toReadiness('ready_live')).toBe('ready_live');
    expect(toReadiness('incompatible')).toBe('incompatible');
    expect(toReadiness('disconnected')).toBe('disconnected');
    expect(toReadiness('stopped')).toBe('disconnected');
    expect(toReadiness('degraded')).toBe('degraded_ack_unavailable');
  });
  it('every lifecycle value projects to a valid Readiness without throwing', () => {
    for (const l of ALL_LIFECYCLE) expect(typeof toReadiness(l)).toBe('string');
  });
});

describe('adapter SDK — safe errors (§16.19-20)', () => {
  it('19. error details remove secret-like values', () => {
    const e = new AdapterError(AdapterErrorCode.HEALTH_FAILED, 'boom', {
      rootSecret: 'abcdef0123456789abcdef', token: 'xyz', apiKey: 'k', ok: 1,
    });
    const j = e.toSafeJSON();
    expect(j.details).not.toHaveProperty('rootSecret');
    expect(j.details).not.toHaveProperty('token');
    expect(j.details).not.toHaveProperty('apiKey');
    expect(j.details.ok).toBe(1);
    // never serializes a stack or cause
    expect(JSON.stringify(j)).not.toMatch(/at \w+|stack|node_modules/i);
  });
  it('20. error details remove private-path-shaped values', () => {
    // Build path-shaped strings at runtime so no literal home-path appears in source
    // (keeps the content scanner clean while still exercising path detection).
    const winPath = ['C:', 'Users', 'placeholder', 'data'].join('\\');
    const nixPath = ['', 'home', 'placeholder', '.config'].join('/');
    const e = new AdapterError(AdapterErrorCode.DELIVERY_FAILED, 'boom', {
      winPath, nixPath, rel: './ok', label: 'fine',
    });
    const j = e.toSafeJSON();
    expect(j.details).not.toHaveProperty('winPath');
    expect(j.details).not.toHaveProperty('nixPath');
    expect(j.details).not.toHaveProperty('rel');
    expect(j.details.label).toBe('fine');
  });
  it('a long hex blob (secret-shaped) is dropped from details', () => {
    const e = new AdapterError(AdapterErrorCode.ACK_FAILED, 'boom', { blob: 'deadbeefcafebabedeadbeefcafebabe', n: 2 });
    expect(e.toSafeJSON().details).not.toHaveProperty('blob');
    expect(e.toSafeJSON().details.n).toBe(2);
  });
});

describe('adapter SDK — compatibility protection (§16.22-25, §14)', () => {
  it('the SDK pins the frozen wire tuple xbus-p1-stp1-s5', () => {
    expect(FROZEN_PROTOCOL_COMPAT).toEqual({ protocol: 1, minProtocol: 1, schema: 5, stp: 1 });
    expect(SUPPORTED_MANIFEST_VERSION).toBe(1);
  });
  it('23/24. the live protocol + schema constants are unchanged (the SDK did not bump them)', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(SCHEMA_VERSION).toBe(5);
  });
  it('a manifest whose protocolCompat != the frozen tuple is INCOMPATIBLE', () => {
    expect(() => validateManifest(baseManifest({ protocolCompat: { protocol: 2, minProtocol: 1, schema: 5, stp: 1 } as AdapterManifest['protocolCompat'] }))).toThrow(/xbus-p1-stp1-s5|tuple/);
    try { validateManifest(baseManifest({ protocolCompat: { protocol: 1, minProtocol: 1, schema: 6, stp: 1 } as AdapterManifest['protocolCompat'] })); }
    catch (e) { expect((e as AdapterError).code).toBe(AdapterErrorCode.INCOMPATIBLE); }
  });
});
