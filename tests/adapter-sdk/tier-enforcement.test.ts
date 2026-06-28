/**
 * PR2 — broker-enforced support tiers + beta.2 compatibility (§7/§9/§10).
 *
 * Proves the keystone rule: an adapter may DECLARE capabilities, but only the broker
 * awards the tier from confirmed evidence — and the enforcement is strictly OPT-IN so
 * legacy beta.2 registrations are a pure no-op.
 */
import { describe, it, expect } from 'vitest';
import { evaluateRegistration, modeRequires, type AdapterRegistration } from '../../src/adapter-broker/enforce.js';
import { emptyCapabilities, confirmCapabilities, toVerified, type AgentCapabilities } from '../../src/adapter/capabilities.js';
import { buildValidationEvidence, emptyStructuredEvidence, computeAwardedSupport, maxLevelForSource, type EvidenceSource } from '../../src/adapter/evidence.js';
import { calculateMaximumTier } from '../../src/adapter/tier.js';
import { ComponentRole } from '../../src/identity/components.js';
import { XBusError } from '../../src/protocol/errors.js';
import { PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { SCHEMA_VERSION, BUILD_ID } from '../../src/protocol/handshake.js';
import { STP_VERSION } from '../../src/ipc/secure-channel.js';
import { MIGRATIONS } from '../../src/database/migrations.js';

function declaring(over: Partial<AgentCapabilities['receive']> = {}, msg: Partial<AgentCapabilities['messaging']> = {}): AgentCapabilities {
  const c = emptyCapabilities();
  c.receive = { ...c.receive, ...over };
  c.messaging = { ...c.messaging, ...msg };
  return c;
}
function reg(over: Partial<AdapterRegistration> = {}): AdapterRegistration {
  return {
    adapterId: 'sample', adapterVersion: '0.0.1', role: ComponentRole.HOOK,
    declaredCapabilities: emptyCapabilities(),
    evidenceSource: 'fake_runtime',
    evidence: {},
    structuredEvidence: { ...emptyStructuredEvidence('sample', '0.0.1'), source: 'fake_runtime' },
    fullConformancePassed: false,
    ...over,
  };
}

describe('PR2 — opt-in: legacy beta.2 registration is a pure no-op (§10)', () => {
  it('no adapterRegistration ⇒ evaluateRegistration returns null (legacy path unchanged)', () => {
    expect(evaluateRegistration('hook_checkpoint', undefined)).toBeNull();
    expect(evaluateRegistration('poll_only', undefined)).toBeNull();
    expect(evaluateRegistration('live_push', undefined)).toBeNull();      // the case the naive design broke
    expect(evaluateRegistration('some_future_mode', undefined)).toBeNull();
  });
  it('modeRequires maps known modes; unknown/legacy modes require nothing', () => {
    expect(modeRequires('manual_pull')).toBe('manualPull');
    expect(modeRequires('hook_checkpoint')).toBe('lifecycleCheckpoint');
    expect(modeRequires('live')).toBe('livePush');
    expect(modeRequires('live_push')).toBe('livePush');
    expect(modeRequires('poll_only')).toBe('none');     // legacy free string ⇒ no requirement
    expect(modeRequires('anything_else')).toBe('none');
  });
});

describe('PR2 — broker awards the tier; adapter cannot self-promote (§7, self-promotion fix)', () => {
  it('a self-declared livePush:"verified" does NOT raise the tier without broker evidence', () => {
    // adapter lies: declares everything verified
    const declared = declaring(
      { manualPull: 'verified', lifecycleCheckpoint: 'verified', livePush: 'verified' },
      { acknowledgements: 'verified', correlatedReplies: 'verified' },
    );
    // but the broker has only fake-runtime evidence for checkpoint + ack (no live)
    const evidence = buildValidationEvidence('fake_runtime', {
      bootedAndRegistered: true, sendVerified: true, manualReceiveVerified: true,
      checkpointReceiveVerified: true, ackReplyVerified: true,
      liveReceiveVerified: true, fullRuntimeValidation: true,   // adapter TRIES to set these
    });
    // source-cap forces live/full false despite the caller passing true:
    expect(evidence.liveReceiveVerified).toBe(false);
    expect(evidence.fullRuntimeValidation).toBe(false);
    const confirmed = confirmCapabilities(declared, evidence);
    const verified = toVerified(ComponentRole.HOOK, confirmed);
    expect(verified.receive.livePush).toBe(false);             // self-declared 'verified' clamped
    expect(verified.receive.lifecycleCheckpoint).toBe(true);   // backed by evidence
    expect(calculateMaximumTier(verified, evidence)).toBe('T3'); // capped at T3, NOT T4/T5
  });

  it('evaluateRegistration awards T3/conformance_tested for a confirmed checkpoint adapter', () => {
    const r = reg({
      role: ComponentRole.HOOK,
      declaredCapabilities: declaring(
        { manualPull: 'declared', lifecycleCheckpoint: 'declared' },
        { acknowledgements: 'declared', correlatedReplies: 'declared' },
      ),
      evidence: { bootedAndRegistered: true, sendVerified: true, manualReceiveVerified: true, checkpointReceiveVerified: true, ackReplyVerified: true },
      fullConformancePassed: true,
    });
    const result = evaluateRegistration('hook_checkpoint', r)!;
    expect(result.awarded.maximumDeliveryTier).toBe('T3');
    expect(result.awarded.validationLevel).toBe('conformance_tested'); // fake source ⇒ never higher
  });

  it('a fake_runtime source can NEVER yield real_runtime_validated (provenance cap)', () => {
    expect(maxLevelForSource('fake_runtime')).toBe('conformance_tested');
    const se = { ...emptyStructuredEvidence('s', '1'), source: 'fake_runtime' as EvidenceSource };
    // Even with a FULL conformance pass + every flag the caller can pass, a fake source
    // is capped at conformance_tested by computeAwardedSupport.
    const verified = toVerified(ComponentRole.HOOK, emptyCapabilities());
    const ev = buildValidationEvidence('fake_runtime', { bootedAndRegistered: true, sendVerified: true });
    expect(computeAwardedSupport(verified, ev, se, true).validationLevel).toBe('conformance_tested');
  });

  it('a real_runtime source CAN reach real_runtime_validated (and live evidence sticks)', () => {
    const ev = buildValidationEvidence('real_runtime', { bootedAndRegistered: true, liveReceiveVerified: true });
    expect(ev.liveReceiveVerified).toBe(true);   // real source keeps the live flag
    const se = { ...emptyStructuredEvidence('s', '1'), source: 'real_runtime' as EvidenceSource };
    const verified = toVerified(ComponentRole.MCP, confirmCapabilities(
      declaring({ livePush: 'declared', lifecycleCheckpoint: 'declared', manualPull: 'declared' }, { acknowledgements: 'declared', correlatedReplies: 'declared' }), ev));
    // not enough evidence flags for T4 here (manual/checkpoint/ack missing) ⇒ still capped low, but level is real
    expect(computeAwardedSupport(verified, ev, se, true).validationLevel).toBe('real_runtime_validated');
  });
});

describe('PR2 — receive-mode over-claim fails closed ONLY on the adapter-aware path (§9)', () => {
  it('an adapter-aware live registration without confirmed livePush is rejected', () => {
    const r = reg({ role: ComponentRole.MCP, declaredCapabilities: declaring({ livePush: 'verified' }) });
    expect(() => evaluateRegistration('live', r)).toThrow(XBusError);
    expect(() => evaluateRegistration('live', r)).toThrow(/livePush/);
  });
  it('an adapter-aware checkpoint registration WITH confirmed checkpoint is accepted', () => {
    const r = reg({
      role: ComponentRole.HOOK,
      declaredCapabilities: declaring({ lifecycleCheckpoint: 'declared' }, { acknowledgements: 'declared', correlatedReplies: 'declared' }),
      evidence: { bootedAndRegistered: true, sendVerified: true, checkpointReceiveVerified: true, ackReplyVerified: true, manualReceiveVerified: true },
      fullConformancePassed: true,
    });
    expect(() => evaluateRegistration('hook_checkpoint', r)).not.toThrow();
  });
  it('an invalid adapter role is rejected', () => {
    const r = reg({ role: 'not-a-role' as ComponentRole });
    expect(() => evaluateRegistration('hook_checkpoint', r)).toThrow(/invalid role/);
  });
});

describe('PR2 — compatibility invariants preserved (§10)', () => {
  it('the three frozen wire axes are unchanged', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MIN_SUPPORTED_PROTOCOL_VERSION).toBe(1);
    expect(STP_VERSION).toBe(1);
    expect(SCHEMA_VERSION).toBe(5);
  });
  it('the DB schema is still at migration 5 (no new migration ⇒ no schema bump)', () => {
    expect(MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0)).toBe(5);
  });
  it('BUILD_ID (wire compatibility id) is unchanged', () => {
    expect(BUILD_ID).toBe('xbus-p1-stp1-s5');
  });
});
