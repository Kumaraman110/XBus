/**
 * LifecycleSimulator (§12) — exercises the full 14-state SessionLifecycle from the
 * merged src/adapter/lifecycle.ts, asserting the prohibited / autonomous-injectable
 * sets and the projection onto the shipping 7-state Readiness (incl. the degraded
 * states the real §2 injection-safety model uses).
 */
import {
  ALL_LIFECYCLE, PROHIBITED_INJECTION, AUTONOMOUS_INJECTABLE, toReadiness,
  type SessionLifecycle,
} from '../../../src/adapter/lifecycle.js';
import { acceptsInjection, resolveReadiness, type Readiness } from '../../../src/broker/readiness.js';

export interface LifecycleCheck {
  state: SessionLifecycle;
  readiness: Readiness;
  prohibited: boolean;
  autonomousInjectable: boolean;
  acceptsInjection: boolean;
}

/** Walk every lifecycle state and capture its injection/readiness projection. */
export function simulateAllStates(): LifecycleCheck[] {
  return ALL_LIFECYCLE.map((state) => {
    const readiness = toReadiness(state);
    return {
      state,
      readiness,
      prohibited: PROHIBITED_INJECTION.has(state),
      autonomousInjectable: AUTONOMOUS_INJECTABLE.has(state),
      acceptsInjection: acceptsInjection(readiness),
    };
  });
}

/**
 * Drive the real `resolveReadiness` for the degraded-path invariants (§2): a receiver
 * that cannot ack lands in degraded_ack_unavailable; a hook_checkpoint receiver whose
 * hook is unavailable lands in degraded_hook_unavailable; a version mismatch is
 * incompatible and supersedes. Returns the resolved Readiness for assertion.
 */
export function resolveDegradedCases(): {
  noAck: Readiness;
  noHook: Readiness;
  versionBad: Readiness;
  healthyCheckpoint: Readiness;
} {
  return {
    noAck: resolveReadiness({ receiveMode: 'hook_checkpoint', capabilities: [], hints: { ackAvailable: false, hookAvailable: true, versionOk: true } }),
    noHook: resolveReadiness({ receiveMode: 'hook_checkpoint', capabilities: ['ack'], hints: { ackAvailable: true, hookAvailable: false, versionOk: true } }),
    versionBad: resolveReadiness({ receiveMode: 'hook_checkpoint', capabilities: ['ack'], hints: { ackAvailable: true, hookAvailable: true, versionOk: false } }),
    healthyCheckpoint: resolveReadiness({ receiveMode: 'hook_checkpoint', capabilities: ['ack'], hints: { ackAvailable: true, hookAvailable: true, versionOk: true } }),
  };
}
