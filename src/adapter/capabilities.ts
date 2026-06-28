/**
 * The capability model (§9). Separates four concepts that must never be conflated:
 *
 *   declared  — what an adapter's manifest CLAIMS (untrusted).
 *   detected  — what `detect()` found in the environment (adapter-observed).
 *   verified  — what the broker/SDK has confirmed (the only basis for a tier award).
 *   awarded   — the support tier the BROKER grants (see tier.ts) — never self-set.
 *
 * A boolean declaration is NEVER proof. Every capability is a tri/quad-state
 * `CapabilityState`, and an adapter cannot set its own awarded support tier.
 */

import { ComponentRole } from '../identity/components.js';

/** unsupported < declared < detected < verified. Only `verified` can raise a tier. */
export type CapabilityState = 'unsupported' | 'declared' | 'detected' | 'verified';

/** The §9 capability groups. Every leaf is a CapabilityState (no bare booleans). */
export interface AgentCapabilities {
  receive: {
    manualPull: CapabilityState;
    lifecycleCheckpoint: CapabilityState;
    livePush: CapabilityState;          // UNPROVEN on Bedrock — see tier.ts
    backgroundWake: CapabilityState;
    idleWake: CapabilityState;
  };
  messaging: {
    acknowledgements: CapabilityState;
    correlatedReplies: CapabilityState;
    progressEvents: CapabilityState;
    cancellation: CapabilityState;
    streaming: CapabilityState;
    structuredPayloads: CapabilityState;
    attachments: CapabilityState;
  };
  lifecycle: {
    sessionStart: CapabilityState;
    sessionStop: CapabilityState;
    promptSubmitted: CapabilityState;
    toolStarted: CapabilityState;
    toolCompleted: CapabilityState;
    turnCompleted: CapabilityState;
  };
  execution: {
    interactive: CapabilityState;
    headless: CapabilityState;
    ideHosted: CapabilityState;
    cliHosted: CapabilityState;
    remoteHosted: CapabilityState;
  };
}

export const CAPABILITY_STATES: readonly CapabilityState[] = ['unsupported', 'declared', 'detected', 'verified'];
const RANK: Record<CapabilityState, number> = { unsupported: 0, declared: 1, detected: 2, verified: 3 };

export function isCapabilityState(v: unknown): v is CapabilityState {
  return typeof v === 'string' && (CAPABILITY_STATES as readonly string[]).includes(v);
}

/** True only when a capability has been VERIFIED — the bar for awarding a tier. */
export function isVerified(s: CapabilityState): boolean { return s === 'verified'; }

/** A capability is "claimed" if declared-or-better; that is NOT proof of support. */
export function isClaimed(s: CapabilityState): boolean { return RANK[s] >= RANK.declared; }

/**
 * The verified view of an agent's capabilities — the ONLY input the broker tier-cap
 * (tier.ts) is allowed to read. Built by lowering every leaf to a boolean that is
 * true iff that capability reached `verified`. An adapter cannot fabricate this:
 * it is produced from broker-side confirmation, never from the manifest.
 */
export interface VerifiedCapabilities {
  role: ComponentRole;
  receive: { manualPull: boolean; lifecycleCheckpoint: boolean; livePush: boolean };
  messaging: { acknowledgements: boolean; correlatedReplies: boolean };
}

/** Lower an AgentCapabilities to its verified-only projection for a given role. */
export function toVerified(role: ComponentRole, caps: AgentCapabilities): VerifiedCapabilities {
  return {
    role,
    receive: {
      manualPull: isVerified(caps.receive.manualPull),
      lifecycleCheckpoint: isVerified(caps.receive.lifecycleCheckpoint),
      livePush: isVerified(caps.receive.livePush),
    },
    messaging: {
      acknowledgements: isVerified(caps.messaging.acknowledgements),
      correlatedReplies: isVerified(caps.messaging.correlatedReplies),
    },
  };
}

/** A blank capability set (everything unsupported) — a safe default for a fresh adapter. */
export function emptyCapabilities(): AgentCapabilities {
  const u: CapabilityState = 'unsupported';
  return {
    receive: { manualPull: u, lifecycleCheckpoint: u, livePush: u, backgroundWake: u, idleWake: u },
    messaging: { acknowledgements: u, correlatedReplies: u, progressEvents: u, cancellation: u, streaming: u, structuredPayloads: u, attachments: u },
    lifecycle: { sessionStart: u, sessionStop: u, promptSubmitted: u, toolStarted: u, toolCompleted: u, turnCompleted: u },
    execution: { interactive: u, headless: u, ideHosted: u, cliHosted: u, remoteHosted: u },
  };
}
