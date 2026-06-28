/**
 * The generic, vendor-neutral session lifecycle vocabulary (§12). This is a strict
 * SUPERSET of the shipping broker/readiness.ts `Readiness` type, and PROJECTS down
 * to it via `toReadiness()` so every existing `acceptsInjection()` caller is
 * unchanged. PR1 introduces the vocabulary + the projection only — it does not
 * change broker injection behavior.
 */

import type { Readiness } from '../broker/readiness.js';

export type SessionLifecycle =
  | 'created'
  | 'starting'
  | 'initializing'
  | 'ready_manual'      // NEW + UNPROVEN — gated, non-injectable until a real CLI adapter proves it
  | 'ready_checkpoint'
  | 'ready_live'        // UNPROVEN on Bedrock (no between-turn push)
  | 'busy'
  | 'paused'
  | 'dnd'
  | 'degraded'
  | 'disconnected'
  | 'stopping'
  | 'stopped'
  | 'incompatible';

export const ALL_LIFECYCLE: readonly SessionLifecycle[] = [
  'created', 'starting', 'initializing', 'ready_manual', 'ready_checkpoint', 'ready_live',
  'busy', 'paused', 'dnd', 'degraded', 'disconnected', 'stopping', 'stopped', 'incompatible',
];

/**
 * States in which the broker MUST NOT inject a fresh request (§12 prohibited set).
 * Note: ready_manual/busy/paused/dnd/degraded are ALSO non-injectable here; they are
 * not "prohibited" in the version-failure sense, but they are not autonomously
 * injectable either (delivery to ready_manual happens only on an explicit pull).
 */
export const PROHIBITED_INJECTION: ReadonlySet<SessionLifecycle> = new Set<SessionLifecycle>([
  'created', 'starting', 'initializing', 'incompatible', 'stopping', 'stopped',
]);

/** The ONLY lifecycle states that autonomously accept a new injection — identical to
 *  the shipping READY_STATES projection ({ready_checkpoint, ready_live}). */
export const AUTONOMOUS_INJECTABLE: ReadonlySet<SessionLifecycle> = new Set<SessionLifecycle>([
  'ready_checkpoint', 'ready_live',
]);

export function isSessionLifecycle(v: unknown): v is SessionLifecycle {
  return typeof v === 'string' && (ALL_LIFECYCLE as readonly string[]).includes(v);
}

/**
 * Project a SessionLifecycle onto the shipping `Readiness` wire/storage type. The
 * new states deliberately map to NON-injectable Readiness values, so the existing
 * `acceptsInjection()` gate refuses them for free with zero change to broker code.
 */
export function toReadiness(l: SessionLifecycle): Readiness {
  switch (l) {
    case 'created':
    case 'starting':
    case 'busy':
    case 'paused':
    case 'dnd':
    case 'ready_manual':       // ready+ack-capable but NOT autonomously injectable
      return 'initializing';
    case 'degraded':
      return 'degraded_ack_unavailable';
    case 'stopping':
    case 'stopped':
      return 'disconnected';
    case 'initializing':
    case 'ready_checkpoint':
    case 'ready_live':
    case 'disconnected':
    case 'incompatible':
      return l;                // identity for the shared names
  }
}
