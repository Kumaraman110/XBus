/**
 * §2 — explicit session readiness model.
 *
 * Connection state ("is a socket attached?") and receive mode ("how does this
 * session take delivery?") do NOT, on their own, tell the broker whether it is
 * safe to inject a request the receiver can actually act on. A session that has
 * registered but not finished initializing (e.g. mid `--continue` resume, or
 * before the hook is installed) must not be handed a requires_ack request it
 * cannot yet acknowledge. Readiness makes that explicit and separate.
 *
 * On Bedrock the normal ready state is `ready_checkpoint`: delivery is taken at
 * a hook checkpoint, not by idle wake-up. `ready_live` is reserved for transports
 * that can push between turns (not available on Bedrock today).
 */

export type Readiness =
  | 'initializing'
  | 'ready_checkpoint'
  | 'ready_live'
  | 'degraded_ack_unavailable'
  | 'degraded_hook_unavailable'
  | 'incompatible'
  | 'disconnected';

export const ALL_READINESS: readonly Readiness[] = [
  'initializing', 'ready_checkpoint', 'ready_live',
  'degraded_ack_unavailable', 'degraded_hook_unavailable', 'incompatible', 'disconnected',
];

/** The only states in which the broker may perform a NEW context injection. */
export const READY_STATES: ReadonlySet<Readiness> = new Set<Readiness>(['ready_checkpoint', 'ready_live']);

/** May the broker inject a fresh request to a session in this readiness state? */
export function acceptsInjection(r: Readiness): boolean {
  return READY_STATES.has(r);
}

export function isReadiness(v: unknown): v is Readiness {
  return typeof v === 'string' && (ALL_READINESS as readonly string[]).includes(v);
}

export interface ReadinessHints {
  /** Can the receiver acknowledge a delivered request right now? */
  ackAvailable?: boolean;
  /** For hook_checkpoint mode: is the checkpoint hook installed/working? */
  hookAvailable?: boolean;
  /** Transport can push between turns (NOT available on Bedrock). */
  live?: boolean;
  /** Version handshake verdict (false ⇒ incompatible, supersedes everything). */
  versionOk?: boolean;
}

/**
 * Resolve the readiness a session should hold given a component's declared
 * capability hints. Pure. The broker NEVER trusts a client to simply assert
 * "ready"; readiness is derived from concrete capabilities + receive mode, so a
 * component that cannot ack lands in `degraded_ack_unavailable`, not ready.
 */
export function resolveReadiness(opts: {
  receiveMode: string;
  capabilities: readonly string[];
  hints: ReadinessHints;
}): Readiness {
  const { receiveMode, capabilities, hints } = opts;
  if (hints.versionOk === false) return 'incompatible';

  // Acknowledgement path is mandatory for a ready receiver (a request injected
  // to a receiver that cannot ack is exactly what §2 forbids).
  const canAck = (hints.ackAvailable ?? capabilities.includes('ack'));
  if (!canAck) return 'degraded_ack_unavailable';

  if (receiveMode === 'hook_checkpoint') {
    // hook_checkpoint takes delivery at a checkpoint; if the hook is known-absent
    // we cannot inject — surface it rather than silently queuing forever.
    if (hints.hookAvailable === false) return 'degraded_hook_unavailable';
    return 'ready_checkpoint';
  }
  // A push-capable transport may go live; otherwise default to checkpoint.
  if (hints.live === true) return 'ready_live';
  return 'ready_checkpoint';
}
