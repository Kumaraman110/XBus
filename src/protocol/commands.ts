/**
 * IPC frame types (control + data plane). A frame is a JSON object with a
 * `frameType`, an optional `requestId` for request/response correlation, and a
 * `payload`. Sender identity is NEVER in the payload — the broker derives it
 * from the authenticated connection's registration.
 */
import { PROTOCOL_VERSION } from './version.js';

export type FrameType =
  | 'hello' | 'hello_ack'
  | 'register_session' | 'register_session_ack'
  | 'announce_session' | 'announce_session_ack'   // beta.5 Phase 1: proactive SessionStart lifecycle signal (visibility) — NOT a routing binding
  | 'ensure_dashboard' | 'ensure_dashboard_ack'   // beta.5: mint a one-time dashboard open-URL (nonce in fragment) from the running broker
  | 'register_alias' | 'register_alias_ack'
  | 'rename_session' | 'rename_session_ack'   // beta.4: choose/change the human-readable session name (resolves pending_name)
  | 'heartbeat' | 'heartbeat_ack'
  | 'send_message' | 'send_message_ack'
  | 'checkpoint_pull' | 'checkpoint_pull_ack'   // hook_checkpoint: receiver pulls pending + marks injected
  | 'checkpoint_pull_hook' | 'checkpoint_pull_hook_ack' // ephemeral hook pull by sessionId (no binding claim)
  | 'ack_message' | 'ack_message_ack'
  | 'reply_message' | 'reply_message_ack'
  | 'list_sessions' | 'list_sessions_ack'
  | 'get_metrics' | 'get_metrics_ack'
  | 'inbox' | 'inbox_ack'
  | 'redeliver' | 'redeliver_ack'
  | 'signal_readiness' | 'signal_readiness_ack'
  | 'get_status' | 'get_status_ack'
  | 'error'
  | 'shutdown' | 'shutdown_ack'
  | 'set_control' | 'set_control_ack'
  | 'process_next' | 'process_next_ack'
  | 'dead_letter' | 'dead_letter_ack'
  | 'block_peer' | 'block_peer_ack'
  | 'takeover' | 'takeover_ack'
  | 'wake_poll' | 'wake_poll_ack'
  | 'shutdown_notice';

export interface Frame {
  protocolVersion: number;
  frameType: FrameType;
  requestId?: string;
  timestamp: string;
  payload: unknown;
}

export function makeFrame(frameType: FrameType, payload: unknown, requestId: string | undefined, nowIso: string): Frame {
  const f: Frame = { protocolVersion: PROTOCOL_VERSION, frameType, timestamp: nowIso, payload };
  if (requestId !== undefined) f.requestId = requestId;
  return f;
}

export interface HelloPayload {
  protocolVersion: number;
  /** Defense-in-depth shared secret (read from the user-only auth file). */
  auth?: string;
}

export interface RegisterPayload {
  sessionId: string;
  instanceId: string;
  processId: number;
  projectId: string;
  cwd: string;
  receiveMode: string;
  capabilities: string[];
  repositoryRoot?: string;
  claudeCodeVersion?: string;
  /** Beta.4 (ADR 0012): a human-readable name the session would like to hold.
   *  Optional + additive — kept SEPARATE from PR #4's nested adapterRegistration so
   *  the two feature sets compose without colliding (ADR 0012 §5). */
  requestedSessionName?: string;
  /** Beta.4: adapter/agent type captured for diagnostics (NOT trust evidence). */
  agentType?: string;
  /** Beta.8 (ADR 0027): ownership proof to reclaim a prior durable identity's name+inbox
   *  under a NEW Claude Code session id. Broker-minted, persisted client-side, presented
   *  verbatim. Optional + additive — a beta.7 client that never sends it gets exact beta.7
   *  behavior. Gated broker-side (secret match + liveness); never a self-promotion. */
  ownerSecret?: string;
}

/**
 * Beta.5 Phase 1 (ADR 0013 D2 / ADR 0020): the SessionStart lifecycle signal.
 * Announced by the SessionStart hook on the connection AFTER register_session, so
 * identity is derived from the authenticated connection — `sessionId` is NEVER read
 * from this payload (the daemon ignores any sessionId here). It carries only the
 * documented SessionStart inputs so the broker can mark the session visible +
 * append exactly one lifecycle ledger event.
 */
export interface AnnouncePayload {
  /** SessionStart `source`: startup | resume | clear | compact (the lifecycle kind).
   *  `resume` also covers `--continue`/`/resume` per the hook contract. */
  source: string;
  /** Working directory reported by the hook (documented input). */
  cwd?: string;
  /** Path to the session transcript .jsonl (documented input). */
  transcriptPath?: string;
  /** Optional agent type (present when launched with `--agent`). */
  agentType?: string;
  /** Beta.7 (ADR 0024): the Claude Code native session title, from the documented SessionStart
   *  `session_title` stdin field. Captured OBSERVE-ONLY into claude_title (separate from the
   *  xbus alias); absent on most starts (only set once a title exists via --name/-n or /rename). */
  sessionTitle?: string;
}
