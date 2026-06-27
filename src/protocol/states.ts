/**
 * Delivery state machine (transport-agnostic).
 *
 * Encodes the consolidated v3 transition table. Transitions are validated
 * centrally here; the persistence layer enforces them with compare-and-set
 * (`UPDATE ... WHERE state=<from> AND <fence>`), so this module is the single
 * source of truth for "is edge X->Y legal".
 *
 * Semantics (see ADR 0001 / docs/protocol.md):
 *   transport_written = the deliver frame was written to the transport
 *   accepted          = the receiver invoked xbus_ack(status:"accepted")
 *   completed         = a terminal reply / completion receipt was recorded
 */

export const DeliveryState = {
  QUEUED: 'queued',
  DISPATCHING: 'dispatching',
  TRANSPORT_WRITTEN: 'transport_written',
  ACCEPTED: 'accepted',
  COMPLETED: 'completed',
  RETRY_WAIT: 'retry_wait',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  DEAD_LETTER: 'dead_letter',
  CANCELLED: 'cancelled',
} as const;

export type DeliveryState = (typeof DeliveryState)[keyof typeof DeliveryState];

/** Terminal (absorbing) states — no outgoing transitions. */
export const TERMINAL_STATES: ReadonlySet<DeliveryState> = new Set([
  DeliveryState.COMPLETED,
  DeliveryState.REJECTED,
  DeliveryState.EXPIRED,
  DeliveryState.DEAD_LETTER,
  DeliveryState.CANCELLED,
]);

/**
 * Trigger names for transitions. A trigger plus a `from` state must map to a
 * single `to` state. Some transitions are guarded by additional conditions
 * (e.g. requiresAck) enforced at the CAS layer — noted per edge.
 */
export const Trigger = {
  PICKUP: 'pickup', // queued -> dispatching
  WRITE_OK: 'write_ok', // dispatching -> transport_written
  WRITE_FAIL: 'write_fail', // dispatching -> retry_wait
  ACK_ACCEPT: 'ack_accept', // transport_written -> accepted
  ACK_REJECT: 'ack_reject', // transport_written|accepted -> rejected
  COMPLETE: 'complete', // transport_written(!requiresAck)|accepted -> completed
  ACK_TIMEOUT: 'ack_timeout', // transport_written -> retry_wait
  BACKOFF_ELAPSED: 'backoff_elapsed', // retry_wait -> dispatching (attempt++)
  MAX_ATTEMPTS: 'max_attempts', // retry_wait -> dead_letter
  EXPIRE: 'expire', // various -> expired
  CANCEL: 'cancel', // various -> cancelled
} as const;

export type Trigger = (typeof Trigger)[keyof typeof Trigger];

interface Edge {
  from: DeliveryState;
  trigger: Trigger;
  to: DeliveryState;
  /** Extra guard the CAS layer must AND into the WHERE clause. */
  guard?: 'requiresAck=0' | 'requiresAck=1';
  /** Only this edge increments the persisted `attempt` column (I23). */
  incrementsAttempt?: boolean;
}

/** The complete, authoritative edge set (consolidated v3). */
export const EDGES: readonly Edge[] = [
  { from: 'queued', trigger: 'pickup', to: 'dispatching' },
  { from: 'queued', trigger: 'expire', to: 'expired' },
  { from: 'queued', trigger: 'cancel', to: 'cancelled' },

  { from: 'dispatching', trigger: 'write_ok', to: 'transport_written' },
  { from: 'dispatching', trigger: 'write_fail', to: 'retry_wait' },
  { from: 'dispatching', trigger: 'expire', to: 'expired' },
  { from: 'dispatching', trigger: 'cancel', to: 'cancelled' },

  { from: 'transport_written', trigger: 'ack_accept', to: 'accepted' },
  { from: 'transport_written', trigger: 'ack_reject', to: 'rejected' },
  { from: 'transport_written', trigger: 'complete', to: 'completed', guard: 'requiresAck=0' },
  { from: 'transport_written', trigger: 'ack_timeout', to: 'retry_wait' },
  { from: 'transport_written', trigger: 'expire', to: 'expired' },
  { from: 'transport_written', trigger: 'cancel', to: 'cancelled' },

  { from: 'accepted', trigger: 'complete', to: 'completed' },
  { from: 'accepted', trigger: 'ack_reject', to: 'rejected' },
  { from: 'accepted', trigger: 'expire', to: 'expired' },
  { from: 'accepted', trigger: 'cancel', to: 'cancelled' },

  { from: 'retry_wait', trigger: 'backoff_elapsed', to: 'dispatching', incrementsAttempt: true },
  { from: 'retry_wait', trigger: 'max_attempts', to: 'dead_letter' },
  { from: 'retry_wait', trigger: 'expire', to: 'expired' },
  { from: 'retry_wait', trigger: 'cancel', to: 'cancelled' },
];

const EDGE_INDEX = new Map<string, Edge>();
for (const e of EDGES) EDGE_INDEX.set(`${e.from}|${e.trigger}`, e);

export interface TransitionResult {
  ok: boolean;
  to?: DeliveryState;
  guard?: Edge['guard'];
  incrementsAttempt?: boolean;
}

/**
 * Resolve a transition. Returns the target state if (from, trigger) is a legal
 * edge, otherwise { ok: false }. Pure — no I/O.
 */
export function resolveTransition(from: DeliveryState, trigger: Trigger): TransitionResult {
  const edge = EDGE_INDEX.get(`${from}|${trigger}`);
  if (!edge) return { ok: false };
  const r: TransitionResult = { ok: true, to: edge.to };
  if (edge.guard !== undefined) r.guard = edge.guard;
  if (edge.incrementsAttempt) r.incrementsAttempt = true;
  return r;
}

/** Is a direct from->to edge legal under ANY trigger? (for guard tests) */
export function isLegalTransition(from: DeliveryState, to: DeliveryState): boolean {
  return EDGES.some((e) => e.from === from && e.to === to);
}

export function isTerminal(state: DeliveryState): boolean {
  return TERMINAL_STATES.has(state);
}
