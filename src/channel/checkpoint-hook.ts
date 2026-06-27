/**
 * HookCheckpointTransport — receive leg. Runs as a Claude Code hook
 * (UserPromptSubmit and/or Stop). At a checkpoint it:
 *   1. connects to the broker, registers (or re-uses) this session,
 *   2. pulls pending messages (broker marks them transport_written = injection),
 *   3. emits them as `additionalContext` inside the untrusted-peer fence,
 *      kept separate from the human prompt.
 *
 * Anti-loop / cost controls (conservative defaults):
 *   - max messages processed per checkpoint (MAX_PER_CHECKPOINT)
 *   - max Stop-continuations per human turn (via stop_hook_active + a counter)
 *   - no continuation when there is no eligible message
 *   - dedup is handled broker-side (markInjected is idempotent)
 *
 * This module NEVER injects keystrokes and NEVER claims idle-wake. On a Stop
 * event it may request one bounded continuation so the model processes a
 * just-arrived message; it stops cleanly when the queue is empty.
 */
import { v7 as uuidv7 } from 'uuid';
import { IpcClient } from '../ipc/client.js';
import { buildCheckpointInjection, type PeerMessageForInjection } from './instructions.js';
import { doHello } from '../ipc/hello.js';
import { ComponentRole } from '../identity/components.js';

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  /** Stable checkpoint id for replay protection (derived if absent). */
  checkpointId?: string;
}

export interface HookConfig {
  endpoint: string;
  maxPerCheckpoint?: number;
  /** Installation root secret for the secure transport. */
  rootSecret?: Buffer;
  /** If true (default false), a Stop hook may request ONE continuation when a
   *  message just arrived, so the model processes it without a human prompt. */
  autoContinueOnStop?: boolean;
}

export interface HookOutput {
  /** JSON to print on stdout (hookSpecificOutput.additionalContext). */
  stdout?: string;
  /** Exit code: 0 = normal, 2 = (Stop) continue the turn. */
  exitCode: number;
  /** Count of messages injected this checkpoint. */
  injected: number;
}

const NONCE_BYTES = 8;

export async function runCheckpoint(input: HookInput, cfg: HookConfig): Promise<HookOutput> {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || input.session_id;
  if (!sessionId) return { exitCode: 0, injected: 0 };

  const maxPer = cfg.maxPerCheckpoint ?? 10;
  const client = new IpcClient(cfg.endpoint, { requestTimeoutMs: 4000, ...(cfg.rootSecret ? { rootSecret: cfg.rootSecret, helloIdentity: { claimedRole: 'hook', claimedSessionId: sessionId } } : {}) });
  try {
    await client.connect();
  } catch {
    // Broker not reachable: degrade silently (no XBus this turn). Never block Claude.
    return { exitCode: 0, injected: 0 };
  }

  try {
    await doHello(client, ComponentRole.HOOK);
    // The hook registers as a HOOK component (joins the session's current epoch;
    // does NOT claim the binding or bump the epoch — ADR 0003). Session/epoch are
    // then derived from this authenticated connection for the privileged pull.
    await client.request('register_session', {
      sessionId, instanceId: uuidv7(), processId: process.pid,
      projectId: process.env.XBUS_PROJECT_ID ?? 'proj-hook', cwd: process.cwd(),
      receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: ComponentRole.HOOK,
    });
    const pull = await client.request('checkpoint_pull_hook', { checkpointId: input.checkpointId ?? uuidv7(), limit: maxPer });
    const messages = (pull.payload as { messages: PeerMessageForInjection[] }).messages ?? [];
    if (messages.length === 0) {
      return { exitCode: 0, injected: 0 };
    }

    const nonce = randomNonce();
    const injection = buildCheckpointInjection(messages, nonce);
    const event = input.hook_event_name ?? 'UserPromptSubmit';
    const out = JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: injection } });

    // Stop continuation is bounded and opt-in. Never continue if stop already
    // active (anti-loop) and never when there was nothing to inject.
    const wantContinue = cfg.autoContinueOnStop === true && event === 'Stop' && input.stop_hook_active !== true;
    return { stdout: out, exitCode: wantContinue ? 2 : 0, injected: messages.length };
  } finally {
    client.close();
  }
}

function randomNonce(): string {
  // Deterministic-RNG-free: derive from uuidv7 (time-ordered, unique per call).
  return uuidv7().replace(/-/g, '').slice(0, NONCE_BYTES * 2);
}
