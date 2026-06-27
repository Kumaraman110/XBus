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
  | 'register_alias' | 'register_alias_ack'
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
}
