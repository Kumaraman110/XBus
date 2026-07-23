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
import { classifyActivation } from './activation-state.js';
import { isPersistentEnabled } from '../cli/user-scope-config.js';

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
  /** JSON to print on stdout (hookSpecificOutput.additionalContext). MODEL-FACING — carries ONLY
   *  peer-message payloads, never AgenTel infrastructure diagnostics (BETA.11 / ADR 0038). */
  stdout?: string;
  /** BETA.11 (ADR 0038): OPERATOR-facing diagnostic text for stderr (activation/degradation
   *  notices). Claude Code shows a hook's stderr to the operator/logs but does NOT fold it into the
   *  model's conversation context — so this NEVER teaches the agent to narrate checkpoint internals
   *  to the end user. The durable-delivery guidance stays a machine fact for operators, not model
   *  chatter. */
  stderr?: string;
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
    const event = input.hook_event_name ?? 'UserPromptSubmit';

    // BETA.10 (ADR 0036) — activation-consistency diagnostic, ONLY at the Stop hook (never at
    // SessionStart: the documented hook-before-MCP registration race would false-positive on every
    // healthy launch). By Stop, a plugin-loaded session's MCP has registered if it ever will, so
    // "no mcp component EVER this epoch" is a true negative = the plugin did not load (bare `claude`).
    // The broker emits the PLUGIN_NOT_LOADED audit AT MOST ONCE per (session, epoch); we surface the
    // honest diagnostic to the user only on that first emission. We NEVER claim connected, and this
    // does NOT touch the durable inbox — any queued messages stay queued for delivery after a correct
    // `xclaude` relaunch.
    let activationNotice = '';
    if (event === 'Stop') {
      try {
        const diag = await client.request('activation_diagnose', {});
        const p = diag.payload as { state?: string; firstEmission?: boolean };
        if (diag.frameType !== 'error' && p.firstEmission === true && (p.state === 'PLUGIN_NOT_LOADED' || p.state === 'DEGRADED_HOOK_ONLY')) {
          // BETA.11 (ADR 0037): give an honest remedy — if persistent activation is enabled, a
          // plugin-absent session must NOT be told to run `xclaude` (plain `claude` is meant to load
          // the plugin); the remedy becomes "start a new session". Best-effort read, never blocks.
          let persistentEnabled = false;
          try { persistentEnabled = isPersistentEnabled(); } catch { /* default false → launcher remedy */ }
          const v = classifyActivation({ mcpComponentRegistered: false, hookAnnounced: p.state === 'DEGRADED_HOOK_ONLY', brokerReachable: true, persistentEnabled });
          // BETA.11 (ADR 0038): this is an OPERATOR diagnostic, NOT model conversation context.
          // Emitting it as model additionalContext (beta.10 behavior) is exactly what taught agents
          // to narrate "my XBus is hook-only, delivery lags, surfaces on the next tick" to the user.
          // It now goes to STDERR (operator/logs), never into the model's context.
          activationNotice = `[XBus activation] ${v.summary}${v.remedy ? ` Remedy: ${v.remedy}.` : ''} Queued messages (if any) remain durably stored; they are NOT auto-delivered while XBus is not connected.`;
        }
      } catch { /* diagnosis is best-effort; never block Claude on it */ }
    }

    if (messages.length === 0 && activationNotice === '') {
      return { exitCode: 0, injected: 0 };
    }

    // MODEL-FACING additionalContext carries ONLY peer messages (untrusted-peer fence) — never the
    // activation diagnostic. The operator notice, if any, is returned separately for stderr.
    const nonce = randomNonce();
    const out = messages.length > 0
      ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: buildCheckpointInjection(messages, nonce) } })
      : undefined;

    // Stop continuation is bounded and opt-in. Never continue if stop already
    // active (anti-loop) and never when there was nothing to inject.
    const wantContinue = cfg.autoContinueOnStop === true && event === 'Stop' && input.stop_hook_active !== true && messages.length > 0;
    return {
      ...(out !== undefined ? { stdout: out } : {}),
      ...(activationNotice !== '' ? { stderr: activationNotice } : {}),
      exitCode: wantContinue ? 2 : 0,
      injected: messages.length,
    };
  } finally {
    client.close();
  }
}

function randomNonce(): string {
  // Deterministic-RNG-free: derive from uuidv7 (time-ordered, unique per call).
  return uuidv7().replace(/-/g, '').slice(0, NONCE_BYTES * 2);
}
