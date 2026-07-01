/**
 * Sample adapters used to drive the conformance runner. These are TEST FIXTURES, not
 * shipping adapters. Two are provided:
 *   - SampleCheckpointAdapter: an honest hook_checkpoint adapter (the Claude-shaped
 *     baseline), built on the merged XBusAdapter contract + the shared fence.
 *   - SelfPromotingAdapter: an ADVERSARIAL adapter that declares every capability
 *     'verified' and claims maturity 'supported' — used to prove the broker refuses
 *     to award it a tier above what evidence supports (self-promotion guard).
 */
import type { XBusAdapter } from '../../../src/adapter/index.js';
import type {
  DetectionContext, DetectionResult, CapabilityContext, CapabilityReport,
  RegistrationContext, ReceiveContext, AcknowledgeContext, ReplyContext, HealthContext, ShutdownContext,
} from '../../../src/adapter/context.js';
import type { AdapterManifest } from '../../../src/adapter/manifest.js';
import type { BrokerFacade } from '../../../src/adapter/facade.js';
import { emptyCapabilities, type AgentCapabilities, type CapabilityState } from '../../../src/adapter/capabilities.js';
import type { RegisteredAgent, ReceiveResult, AcknowledgeResult, ReplyResult, HealthResult } from '../../../src/adapter/results.js';
import { AdapterError, AdapterErrorCode } from '../../../src/adapter/errors.js';
import { buildCheckpointInjection } from '../../../src/channel/instructions.js';
import { ComponentRole } from '../../../src/identity/components.js';

function caps(receive: Partial<AgentCapabilities['receive']>, messaging: Partial<AgentCapabilities['messaging']>): AgentCapabilities {
  const c = emptyCapabilities();
  c.receive = { ...c.receive, ...receive };
  c.messaging = { ...c.messaging, ...messaging };
  return c;
}

function baseManifest(id: string, declared: AgentCapabilities, maturity: AdapterManifest['support']['maturity']): AdapterManifest {
  return {
    manifestVersion: 1,
    adapter: { id, name: id, version: '0.0.1', publisher: 'conformance-fixture' },
    platform: { id: `${id}-rt`, displayName: `${id} runtime` },
    vendorAffiliation: 'none',
    receiveModes: ['hook_checkpoint'],
    protocolCompat: { protocol: 1, minProtocol: 1, schema: 5, stp: 1 },
    xbus: { adapterSdkRange: '0.1.x', protocolRange: '1' },
    entrypoint: 'dist/adapter.js',
    declaredCapabilities: declared,
    permissions: [],
    support: { maturity },
  };
}

/** Honest checkpoint adapter — declares capabilities as 'declared' (never self-'verified'). */
export class SampleCheckpointAdapter implements XBusAdapter {
  private declared = caps(
    { manualPull: 'declared' as CapabilityState, lifecycleCheckpoint: 'declared' as CapabilityState },
    { acknowledgements: 'declared' as CapabilityState, correlatedReplies: 'declared' as CapabilityState },
  );
  private detected = true;
  constructor(opts: { detected?: boolean } = {}) { this.detected = opts.detected ?? true; }

  manifest(): AdapterManifest { return baseManifest('sample-checkpoint', this.declared, 'experimental'); }
  detect(_ctx: DetectionContext): Promise<DetectionResult> {
    return Promise.resolve(this.detected ? { available: true, confidence: 'certain' } : { available: false, reason: 'not detected' });
  }
  capabilities(_ctx: CapabilityContext): Promise<CapabilityReport> { return Promise.resolve({ role: ComponentRole.HOOK, capabilities: this.declared }); }
  async register(_ctx: RegistrationContext, facade: BrokerFacade): Promise<RegisteredAgent> {
    await facade.registerSession({ sessionId: _ctx.identity.sessionId, receiveMode: 'hook_checkpoint' });
    return { identity: _ctx.identity, awardedTier: 'T0' }; // broker overrides; adapter never asserts its own
  }
  async receive(ctx: ReceiveContext, facade: BrokerFacade): Promise<ReceiveResult> {
    const pulled = await facade.pullCheckpoint({ checkpointId: ctx.checkpointId, limit: ctx.limit }) as Array<{ injectionId: string; body: string }>;
    if (!pulled.length) return { presentation: '', injected: 0, wantsContinuation: false };
    // present through the SHARED fence (neutralizes markers, host-nonce END)
    const presentation = buildCheckpointInjection(
      pulled.map((m, i) => ({ messageId: 'm', senderAlias: 'peer', sequence: i, requiresAck: true, requiresReply: false, text: m.body, metadata: { xbus_injection_id: m.injectionId } })),
      `nonce-${ctx.checkpointId}`,
    );
    return { presentation, injected: pulled.length, wantsContinuation: ctx.eventName === 'Stop' && ctx.stopActive !== true };
  }
  async acknowledge(ctx: AcknowledgeContext, facade: BrokerFacade): Promise<AcknowledgeResult> {
    await facade.acknowledge({ injectionId: ctx.injectionId, status: ctx.status });
    return { ok: true, messageId: ctx.messageId };
  }
  async reply(ctx: ReplyContext, facade: BrokerFacade): Promise<ReplyResult> {
    await facade.reply({ injectionId: ctx.injectionId, text: ctx.text });
    return { ok: true };
  }
  health(_ctx: HealthContext): Promise<HealthResult> { return Promise.resolve({ ready: true, ackAvailable: true, versionOk: true }); }
  shutdown(_ctx: ShutdownContext): Promise<void> { return Promise.resolve(); }
}

/** Adversarial adapter: declares EVERYTHING verified + maturity 'supported'. */
export class SelfPromotingAdapter extends SampleCheckpointAdapter {
  private liar = caps(
    { manualPull: 'verified' as CapabilityState, lifecycleCheckpoint: 'verified' as CapabilityState, livePush: 'verified' as CapabilityState },
    { acknowledgements: 'verified' as CapabilityState, correlatedReplies: 'verified' as CapabilityState },
  );
  manifest(): AdapterManifest { return baseManifest('self-promoting', this.liar, 'supported'); }
  capabilities(_ctx: CapabilityContext): Promise<CapabilityReport> { return Promise.resolve({ role: ComponentRole.MCP, capabilities: this.liar }); }
}

/** An adapter whose detect() throws — to prove the runner treats detect as non-throwing. */
export class ThrowingDetectAdapter extends SampleCheckpointAdapter {
  detect(_ctx: DetectionContext): Promise<DetectionResult> { throw new AdapterError(AdapterErrorCode.NOT_DETECTED, 'boom'); }
}
