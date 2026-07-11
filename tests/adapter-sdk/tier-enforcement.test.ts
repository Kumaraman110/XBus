/**
 * PR2 — broker-enforced tiers + TRUST BOUNDARY (§1-§9) + beta.2 compatibility (§10).
 *
 * Central invariant proven here: adapters may DECLARE capabilities, but the trusted
 * evidence that verifies them is BROKER-OWNED. The adapter frame carries only an
 * untrusted declaration; it cannot supply evidence provenance or verified flags.
 */
import { describe, it, expect } from 'vitest';
import { evaluateRegistration, modeRequires, type AdapterRegistrationDeclaration } from '../../src/adapter-broker/enforce.js';
import { TrustedEvidenceRegistry, type BrokerTrustedEvidence } from '../../src/adapter-broker/trusted-evidence.js';
import { emptyCapabilities, confirmCapabilities, toVerified, type AgentCapabilities } from '../../src/adapter/capabilities.js';
import { buildValidationEvidence, computeAwardedSupport, emptyStructuredEvidence, maxLevelForSource, type EvidenceSource } from '../../src/adapter/evidence.js';
import { calculateMaximumTier } from '../../src/adapter/tier.js';
import { ComponentRole } from '../../src/identity/components.js';
import { XBusError } from '../../src/protocol/errors.js';
import { PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { SCHEMA_VERSION, BUILD_ID } from '../../src/protocol/handshake.js';
import { STP_VERSION } from '../../src/ipc/secure-channel.js';
import { MIGRATIONS } from '../../src/database/migrations.js';

function declaring(receive: Partial<AgentCapabilities['receive']> = {}, msg: Partial<AgentCapabilities['messaging']> = {}): AgentCapabilities {
  const c = emptyCapabilities();
  c.receive = { ...c.receive, ...receive };
  c.messaging = { ...c.messaging, ...msg };
  return c;
}
function decl(over: Partial<AdapterRegistrationDeclaration> = {}): AdapterRegistrationDeclaration {
  return { adapterId: 'sample', adapterVersion: '0.0.1', role: ComponentRole.HOOK, declaredCapabilities: emptyCapabilities(), ...over };
}
function brokerEvidence(over: Partial<BrokerTrustedEvidence> = {}): BrokerTrustedEvidence {
  return {
    source: 'conformance_runner', adapterId: 'sample', adapterVersion: '0.0.1', role: ComponentRole.HOOK,
    capabilities: { sendVerified: true, manualReceiveVerified: true, checkpointReceiveVerified: true, liveReceiveVerified: false, ackReplyVerified: true },
    durability: { brokerRestartVerified: false, reconnectVerified: false, queuedDeliveryVerified: false },
    security: { fencingVerified: false, redactionVerified: false, packagedRuntimeVerified: false },
    conformanceVersion: 1,
    ...over,
  };
}
const HOOK_AUTH = { role: ComponentRole.HOOK, sessionId: 's-1' };

describe('PR2 §1-§2 — trusted evidence is broker-owned, never from the frame', () => {
  it('the declaration type carries NO evidence/provenance fields (compile-time + shape)', () => {
    const d = decl();
    // Only declaration fields exist; there is no evidenceSource/evidence/fullConformancePassed.
    expect(Object.keys(d).sort()).toEqual(['adapterId', 'adapterVersion', 'declaredCapabilities', 'role']);
  });
  it('evaluateRegistration takes broker-owned trustedEvidence as a separate arg', () => {
    const r = evaluateRegistration({ receiveMode: 'hook_checkpoint', declaration: decl({ declaredCapabilities: declaring({ lifecycleCheckpoint: 'declared' }, { acknowledgements: 'declared', correlatedReplies: 'declared' }) }), authority: HOOK_AUTH, trustedEvidence: brokerEvidence() })!;
    expect(r.awarded.maximumDeliveryTier).toBe('T3');
    expect(r.awarded.validationLevel).toBe('conformance_tested');
  });
});

describe('final-review R12 — malformed untrusted declaredCapabilities fails PROTOCOL_VIOLATION (not a raw TypeError)', () => {
  // The adapterRegistration frame is UNTRUSTED and cast unchecked at the daemon boundary.
  // A malformed declaredCapabilities must be rejected with a clean PROTOCOL_VIOLATION
  // BEFORE confirmCapabilities/toVerified dereference it — never a raw TypeError surfaced
  // as a mislabeled internal error. Role still matches authority so we reach the shape check.
  const bad = (declaredCapabilities: unknown): AdapterRegistrationDeclaration =>
    ({ adapterId: 'shape', adapterVersion: '1', role: ComponentRole.HOOK, declaredCapabilities } as unknown as AdapterRegistrationDeclaration);
  const call = (declaredCapabilities: unknown): unknown =>
    evaluateRegistration({ receiveMode: 'poll_only', declaration: bad(declaredCapabilities), authority: HOOK_AUTH, trustedEvidence: undefined });

  it('omitted declaredCapabilities throws PROTOCOL_VIOLATION (not TypeError)', () => {
    expect(() => call(undefined)).toThrow(XBusError);
    try { call(undefined); } catch (e) { expect((e as XBusError).code).toBe('XBUS_PROTOCOL_VIOLATION'); }
  });
  it('empty-object declaredCapabilities (missing groups) throws PROTOCOL_VIOLATION', () => {
    expect(() => call({})).toThrow(/declaredCapabilities\.receive/);
  });
  it('a group present but a leaf not a CapabilityState throws PROTOCOL_VIOLATION', () => {
    const caps = emptyCapabilities() as unknown as Record<string, Record<string, unknown>>;
    caps.receive.manualPull = 'bogus-state';
    expect(() => call(caps)).toThrow(/manualPull is not a valid CapabilityState/);
  });
  it('a well-formed emptyCapabilities() declaration is accepted (no false positive)', () => {
    expect(() => call(emptyCapabilities())).not.toThrow();
  });
});

describe('PR2 §3 — fail closed when broker evidence is absent', () => {
  it('an adapter-aware registration WITHOUT broker evidence awards nothing & rejects advanced modes', () => {
    // requests hook_checkpoint, declares it verified, but broker has NO evidence
    const d = decl({ declaredCapabilities: declaring({ lifecycleCheckpoint: 'verified' }, { acknowledgements: 'verified', correlatedReplies: 'verified' }) });
    expect(() => evaluateRegistration({ receiveMode: 'hook_checkpoint', declaration: d, authority: HOOK_AUTH, trustedEvidence: undefined }))
      .toThrow(/no broker-owned evidence/);
  });
  it('with no evidence, a no-requirement mode awards T0/unvalidated (no silent verified caps)', () => {
    const d = decl({ role: ComponentRole.CLI, declaredCapabilities: declaring({}, {}), adapterId: 'cli-x' });
    const r = evaluateRegistration({ receiveMode: 'poll_only', declaration: d, authority: { role: ComponentRole.CLI, sessionId: 's' }, trustedEvidence: undefined })!;
    expect(r.awarded.maximumDeliveryTier).toBe('T0');
    expect(r.awarded.validationLevel).toBe('unvalidated');
  });
  it('all advanced modes are rejected without evidence', () => {
    for (const mode of ['manual_pull', 'hook_checkpoint', 'live_push', 'live']) {
      expect(() => evaluateRegistration({ receiveMode: mode, declaration: decl({ declaredCapabilities: declaring({ manualPull: 'verified', lifecycleCheckpoint: 'verified', livePush: 'verified' }) }), authority: HOOK_AUTH, trustedEvidence: undefined }))
        .toThrow(XBusError);
    }
  });
});

describe('PR2 §9 — adversarial: adapter cannot forge provenance', () => {
  it('a declaration claiming everything verified gets NO tier without broker evidence', () => {
    const liar = decl({ role: ComponentRole.MCP, adapterId: 'liar', declaredCapabilities: declaring(
      { manualPull: 'verified', lifecycleCheckpoint: 'verified', livePush: 'verified' },
      { acknowledgements: 'verified', correlatedReplies: 'verified' }) });
    // a no-requirement mode so we can inspect the award rather than a throw
    const r = evaluateRegistration({ receiveMode: 'poll_only', declaration: liar, authority: { role: ComponentRole.MCP, sessionId: 's' }, trustedEvidence: undefined })!;
    expect(r.awarded.maximumDeliveryTier).toBe('T0');
    expect(r.awarded.validationLevel).toBe('unvalidated');
    expect(r.confirmedVerified.receive.livePush).toBe(false);
  });
  it('conformance_runner evidence can NEVER award T4/T5 or real_runtime_validated (provenance cap)', () => {
    // broker evidence claims live + full true, but source is conformance_runner (fake)
    const ev = brokerEvidence({ source: 'conformance_runner',
      capabilities: { sendVerified: true, manualReceiveVerified: true, checkpointReceiveVerified: true, liveReceiveVerified: true, ackReplyVerified: true },
      durability: { brokerRestartVerified: true, reconnectVerified: true, queuedDeliveryVerified: true },
      security: { fencingVerified: true, redactionVerified: true, packagedRuntimeVerified: true } });
    const d = decl({ role: ComponentRole.MCP, declaredCapabilities: declaring({ livePush: 'declared', lifecycleCheckpoint: 'declared', manualPull: 'declared' }, { acknowledgements: 'declared', correlatedReplies: 'declared' }) });
    // live mode would be requested — but conformance source caps live false ⇒ rejected
    expect(() => evaluateRegistration({ receiveMode: 'live', declaration: d, authority: { role: ComponentRole.MCP, sessionId: 's' }, trustedEvidence: { ...ev, role: ComponentRole.MCP } }))
      .toThrow(/livePush/);
    // and a checkpoint registration is capped at T3/conformance_tested
    const r = evaluateRegistration({ receiveMode: 'hook_checkpoint', declaration: d, authority: { role: ComponentRole.MCP, sessionId: 's' }, trustedEvidence: { ...ev, role: ComponentRole.MCP } })!;
    expect(r.awarded.maximumDeliveryTier).toBe('T3');
    expect(r.awarded.validationLevel).toBe('conformance_tested');
  });
  it('real_runtime_validation source CAN reach real_runtime_validated', () => {
    const ev = brokerEvidence({ source: 'real_runtime_validation',
      capabilities: { sendVerified: true, manualReceiveVerified: true, checkpointReceiveVerified: true, liveReceiveVerified: false, ackReplyVerified: true } });
    const d = decl({ declaredCapabilities: declaring({ lifecycleCheckpoint: 'declared', manualPull: 'declared' }, { acknowledgements: 'declared', correlatedReplies: 'declared' }) });
    const r = evaluateRegistration({ receiveMode: 'hook_checkpoint', declaration: d, authority: HOOK_AUTH, trustedEvidence: ev })!;
    expect(r.awarded.maximumDeliveryTier).toBe('T3');
    expect(r.awarded.validationLevel).toBe('real_runtime_validated');
  });
});

describe('PR2 §4 — evidence is bound to exact adapter identity (registry rejects mismatches)', () => {
  const reg = new TrustedEvidenceRegistry();
  reg.record(brokerEvidence({ adapterId: 'A', adapterVersion: '1', role: ComponentRole.HOOK }));
  it('evidence for A@1 does NOT resolve for A@2', () => {
    expect(reg.resolve({ adapterId: 'A', adapterVersion: '2', role: ComponentRole.HOOK }).ok).toBe(false);
    expect(reg.resolve({ adapterId: 'A', adapterVersion: '2', role: ComponentRole.HOOK }).reason).toBe('absent');
  });
  it('evidence for A does NOT resolve for B', () => {
    expect(reg.resolve({ adapterId: 'B', adapterVersion: '1', role: ComponentRole.HOOK }).ok).toBe(false);
  });
  it('evidence for HOOK does NOT resolve for MCP role', () => {
    expect(reg.resolve({ adapterId: 'A', adapterVersion: '1', role: ComponentRole.MCP }).ok).toBe(false);
  });
  it('the exact identity resolves', () => {
    expect(reg.resolve({ adapterId: 'A', adapterVersion: '1', role: ComponentRole.HOOK }).ok).toBe(true);
  });
  it('an unsupported conformance version fails closed', () => {
    const r2 = new TrustedEvidenceRegistry();
    r2.record(brokerEvidence({ adapterId: 'C', adapterVersion: '1', role: ComponentRole.HOOK, conformanceVersion: 99 }));
    expect(r2.resolve({ adapterId: 'C', adapterVersion: '1', role: ComponentRole.HOOK }).reason).toBe('unsupported_conformance_version');
  });
  it('a build mismatch fails closed', () => {
    const r3 = new TrustedEvidenceRegistry();
    r3.record(brokerEvidence({ adapterId: 'D', adapterVersion: '1', role: ComponentRole.HOOK, buildId: 'build-1' }));
    expect(r3.resolve({ adapterId: 'D', adapterVersion: '1', role: ComponentRole.HOOK, buildId: 'build-2' }).reason).toBe('build_mismatch');
  });

  it('final-review #7: buildId binding is SYMMETRIC (presence/absence is part of the exact tuple)', () => {
    // Evidence PINNED to a build must NOT resolve for a query that omits buildId
    // (adapter can\'t drop buildId to borrow build-scoped evidence).
    const rPinned = new TrustedEvidenceRegistry();
    rPinned.record(brokerEvidence({ adapterId: 'E', adapterVersion: '1', role: ComponentRole.HOOK, buildId: 'build-1' }));
    expect(rPinned.resolve({ adapterId: 'E', adapterVersion: '1', role: ComponentRole.HOOK }).ok).toBe(false);
    expect(rPinned.resolve({ adapterId: 'E', adapterVersion: '1', role: ComponentRole.HOOK }).reason).toBe('build_mismatch');
    // Build-AGNOSTIC evidence (no buildId) must NOT resolve for a query that supplies one
    // (adapter can\'t invent a buildId to match broad evidence under a narrow claim).
    const rAgnostic = new TrustedEvidenceRegistry();
    rAgnostic.record(brokerEvidence({ adapterId: 'F', adapterVersion: '1', role: ComponentRole.HOOK })); // no buildId
    expect(rAgnostic.resolve({ adapterId: 'F', adapterVersion: '1', role: ComponentRole.HOOK, buildId: 'anything' }).ok).toBe(false);
    expect(rAgnostic.resolve({ adapterId: 'F', adapterVersion: '1', role: ComponentRole.HOOK, buildId: 'anything' }).reason).toBe('build_mismatch');
    // Exact match (both absent) still resolves; (both present + equal) still resolves.
    expect(rAgnostic.resolve({ adapterId: 'F', adapterVersion: '1', role: ComponentRole.HOOK }).ok).toBe(true);
    expect(rPinned.resolve({ adapterId: 'E', adapterVersion: '1', role: ComponentRole.HOOK, buildId: 'build-1' }).ok).toBe(true);
  });
});

describe('PR2 §5 — declared role must match authenticated authority', () => {
  const ev = brokerEvidence({ role: ComponentRole.HOOK });
  it('HOOK authority declaring MCP role is rejected', () => {
    expect(() => evaluateRegistration({ receiveMode: 'hook_checkpoint', declaration: decl({ role: ComponentRole.MCP }), authority: HOOK_AUTH, trustedEvidence: ev }))
      .toThrow(/authenticated as role 'hook' but declared role 'mcp'/);
  });
  it('MCP authority declaring HOOK role is rejected', () => {
    expect(() => evaluateRegistration({ receiveMode: 'hook_checkpoint', declaration: decl({ role: ComponentRole.HOOK }), authority: { role: ComponentRole.MCP, sessionId: 's' }, trustedEvidence: ev }))
      .toThrow(/authenticated as role 'mcp' but declared role 'hook'/);
  });
  it('an invalid declared role is rejected', () => {
    expect(() => evaluateRegistration({ receiveMode: 'hook_checkpoint', declaration: decl({ role: 'bogus' as ComponentRole }), authority: HOOK_AUTH, trustedEvidence: ev }))
      .toThrow(/invalid role/);
  });
  it('a matching role with evidence is accepted', () => {
    const d = decl({ declaredCapabilities: declaring({ lifecycleCheckpoint: 'declared' }, { acknowledgements: 'declared', correlatedReplies: 'declared' }) });
    expect(() => evaluateRegistration({ receiveMode: 'hook_checkpoint', declaration: d, authority: HOOK_AUTH, trustedEvidence: ev })).not.toThrow();
  });
});

describe('PR2 §10 — compatibility invariants + legacy no-op', () => {
  it('legacy registration (no declaration) is a pure no-op for every mode', () => {
    for (const m of ['hook_checkpoint', 'poll_only', 'live_push', 'future_mode']) {
      expect(evaluateRegistration({ receiveMode: m, declaration: undefined, authority: HOOK_AUTH, trustedEvidence: undefined })).toBeNull();
    }
  });
  it('modeRequires maps known modes; unknown/legacy require nothing', () => {
    expect(modeRequires('manual_pull')).toBe('manualPull');
    expect(modeRequires('hook_checkpoint')).toBe('lifecycleCheckpoint');
    expect(modeRequires('live')).toBe('livePush');
    expect(modeRequires('poll_only')).toBe('none');
  });
  it('the protocol + STP wire axes remain frozen at 1 (proto/STP unchanged by beta.4)', () => {
    // PR #4 changed NEITHER proto NOR STP; beta.4 also leaves both frozen. Only the
    // additive DB schema moved (see below). These two are the true wire-compat axes.
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MIN_SUPPORTED_PROTOCOL_VERSION).toBe(1);
    expect(STP_VERSION).toBe(1);
  });
  it('the live DB schema is at migration 6 / xbus-p1-stp1-s6 post-composition (beta.4 ADR 0012 §3)', () => {
    // PR #4 itself made NO schema change (it was s5 on its own branch). Composing it
    // with beta.4 — whose owner-approved migration v6 adds the additive session-name +
    // 15-day-retention columns — advances the LIVE schema to 6 and the compatibility
    // id to xbus-p1-stp1-s6 (proto+STP still 1). Fail-closed by design: a beta.3/PR#4
    // s5 client is told to upgrade. The FROZEN adapter-SDK compat contract that must
    // stay byte-pinned at schema 5 lives separately in tests/adapter-sdk/adapter-sdk.test.ts.
    expect(SCHEMA_VERSION).toBe(6);
    expect(MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0)).toBe(6);
    expect(BUILD_ID).toBe('xbus-p1-stp1-s6');
  });
});

describe('PR2 — provenance helpers (sanity)', () => {
  it('maxLevelForSource caps fake at conformance_tested', () => {
    expect(maxLevelForSource('fake_runtime')).toBe('conformance_tested');
    expect(maxLevelForSource('real_runtime')).toBe('real_runtime_validated');
    expect(maxLevelForSource('real_runtime_signed_off')).toBe('supported');
    expect(maxLevelForSource('none')).toBe('unvalidated');
  });
  it('confirmCapabilities clamps self-declared verified to declared without evidence', () => {
    const ev = buildValidationEvidence('fake_runtime', {});
    const v = toVerified(ComponentRole.MCP, confirmCapabilities(declaring({ livePush: 'verified' }), ev));
    expect(v.receive.livePush).toBe(false);
  });
  it('computeAwardedSupport honors the fake-runtime cap end-to-end', () => {
    const verified = toVerified(ComponentRole.HOOK, emptyCapabilities());
    const ev = buildValidationEvidence('fake_runtime', { bootedAndRegistered: true });
    const se = { ...emptyStructuredEvidence('s', '1'), source: 'fake_runtime' as EvidenceSource };
    expect(computeAwardedSupport(verified, ev, se, true).validationLevel).toBe('conformance_tested');
  });
});

describe('re-review R4: secret- and telemetry-redaction are tracked INDEPENDENTLY', () => {
  // The two redaction properties are orthogonal and are now stored/consumed independently
  // (secretRedactionVerified / telemetryRedactionVerified), with the deprecated single
  // `redactionVerified` flag feeding BOTH for back-compat. These flags contribute to the
  // full-runtime security posture; this test pins that evidence resolves + awards WITHOUT
  // error under each combination and that the deprecated flag is honored (no crash on the
  // absent specific flags), i.e. the split did not regress the trust path.
  const D = (o: Partial<AdapterRegistrationDeclaration> = {}) => decl({ role: ComponentRole.MCP, declaredCapabilities: declaring({ lifecycleCheckpoint: 'declared' }, { acknowledgements: 'declared', correlatedReplies: 'declared' }), ...o });
  const auth = { role: ComponentRole.MCP, sessionId: 's' };
  function realEvidence(over: Partial<BrokerTrustedEvidence['security']>): BrokerTrustedEvidence {
    return brokerEvidence({
      source: 'real_runtime_validation', role: ComponentRole.MCP,
      capabilities: { sendVerified: true, manualReceiveVerified: true, checkpointReceiveVerified: true, liveReceiveVerified: false, ackReplyVerified: true },
      durability: { brokerRestartVerified: true, reconnectVerified: true, queuedDeliveryVerified: true },
      security: { fencingVerified: true, packagedRuntimeVerified: true, ...over },
    });
  }
  it('resolves + awards under each redaction combination (secret-only, telemetry-only, both)', () => {
    for (const sec of [true, false]) for (const tel of [true, false]) {
      const r = evaluateRegistration({ receiveMode: 'hook_checkpoint', declaration: D(), authority: auth, trustedEvidence: realEvidence({ secretRedactionVerified: sec, telemetryRedactionVerified: tel }) })!;
      expect(r.awarded.maximumDeliveryTier).toBe('T3'); // checkpoint-mode delivery award (from verified caps)
      expect(r.awarded.validationLevel).toBe('real_runtime_validated');
    }
  });
  it('deprecated single redactionVerified flag is honored for BOTH (back-compat, no crash on absent specific flags)', () => {
    const r = evaluateRegistration({ receiveMode: 'hook_checkpoint', declaration: D(), authority: auth, trustedEvidence: realEvidence({ redactionVerified: true }) })!;
    expect(r.awarded.maximumDeliveryTier).toBe('T3');
    expect(r.awarded.validationLevel).toBe('real_runtime_validated');
  });
});
