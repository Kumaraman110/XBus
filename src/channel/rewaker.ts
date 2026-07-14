/**
 * The RESIDENT idle-wake accelerator (beta.7 Phase 3, ADR 0025).
 *
 * Registered as a SessionStart hook with `asyncRewake: true` (the documented Claude Code
 * mechanism: a background `type:command` hook that, on EXIT CODE 2, wakes Claude with a system
 * reminder). Unlike the synchronous checkpoint hook, this one is launched ONCE at SessionStart
 * and stays RESIDENT: it connects to the broker and polls `wake_poll` for THIS session; the
 * FIRST time the broker reports an eligible queued delivery, it prints a short system-reminder
 * line and exits 2 — waking the session so its EXISTING checkpoint hook pulls the body.
 *
 * HONESTY (ADR 0025): this NEVER carries a message body (only a "there is a pending delivery"
 * reminder), NEVER injects keystrokes, and the broker NEVER pushes into the conversation. The
 * durable QUEUED delivery + the pull path are the correctness FLOOR; this only reduces latency.
 * Whether a resident SessionStart asyncRewake hook actually stays resident + wakes a truly-idle
 * session is host-dependent and NOT guaranteed by the docs — it is gated behind a `doctor`
 * spawn-probe; if it doesn't fire, delivery still happens on the session's next real checkpoint.
 *
 * Fail-open: any broker-unreachable / timeout / malformed-input path exits 0 (no wake, never
 * blocks Claude). Bounded lifetime so a stuck resident hook can't run forever.
 */
import { IpcClient } from '../ipc/client.js';
import { doHello } from '../ipc/hello.js';
import { ComponentRole } from '../identity/components.js';

export interface RewakerInput {
  session_id?: string;
  hook_event_name?: string;
}

export interface RewakerConfig {
  endpoint: string;
  rootSecret?: Buffer;
  /** Poll interval (ms) while waiting for an eligible delivery. Default 3s. */
  pollIntervalMs?: number;
  /** Max resident lifetime (ms) before exiting 0 (no wake). Default 30 min — bounds a stuck
   *  hook; a real SessionStart re-arms it on the next session event. */
  maxLifetimeMs?: number;
  /** Injectable now() for tests (ms). */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RewakerResult {
  /** 0 = no wake (timed out / unreachable / not eligible), 2 = fire asyncRewake (documented). */
  exitCode: 0 | 2;
  /** The system-reminder line to print on exit 2 (never a message body). */
  reminder?: string;
  /** Diagnostics. */
  reason: 'eligible' | 'timeout' | 'unreachable' | 'no_session' | 'closed';
}

/** The exact reminder text shown to Claude on wake — deliberately body-free. */
export const WAKE_REMINDER = 'XBus has a pending delivery for this session; a checkpoint will present it.';

/**
 * Run the resident rewaker to completion (one wake or a bounded timeout). Pure of process
 * concerns (no process.exit here) so it is unit-testable: the entry wrapper maps the result to
 * an exit code + stdout. Polls `wake_poll` until eligible → {exitCode:2}, or the lifetime
 * elapses → {exitCode:0}. Any connection failure → {exitCode:0} (fail-open).
 */
export async function runRewaker(input: RewakerInput, cfg: RewakerConfig): Promise<RewakerResult> {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || input.session_id;
  if (!sessionId) return { exitCode: 0, reason: 'no_session' };
  const pollMs = cfg.pollIntervalMs ?? 3000;
  const maxMs = cfg.maxLifetimeMs ?? 30 * 60_000;
  const now = cfg.now ?? (() => Date.now());
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();

  const client = new IpcClient(cfg.endpoint, { requestTimeoutMs: 4000, ...(cfg.rootSecret ? { rootSecret: cfg.rootSecret, helloIdentity: { claimedRole: 'hook', claimedSessionId: sessionId } } : {}) });
  try {
    await client.connect();
    await doHello(client, ComponentRole.HOOK);
    // Register as a HOOK component (joins the session's current epoch, like the checkpoint
    // hook) so wake_poll — which requires an authenticated connection — is authorized. The
    // hook role never becomes the session's live writer; it just needs a registered connection.
    await client.request('register_session', { sessionId, instanceId: `rewaker-${sessionId.slice(0, 8)}`, processId: process.pid, projectId: 'proj-hook', cwd: process.cwd(), receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: ComponentRole.HOOK });
  } catch {
    return { exitCode: 0, reason: 'unreachable' }; // fail-open: broker not reachable → no wake
  }
  try {
    for (;;) {
      let eligible = false;
      try {
        const r = await client.request('wake_poll', {});
        eligible = r.frameType === 'wake_poll_ack' && (r.payload as { eligible?: boolean }).eligible === true;
      } catch {
        return { exitCode: 0, reason: 'closed' }; // broker went away → fail-open
      }
      if (eligible) return { exitCode: 2, reminder: WAKE_REMINDER, reason: 'eligible' };
      if (now() - started >= maxMs) return { exitCode: 0, reason: 'timeout' };
      await sleep(pollMs);
    }
  } finally {
    try { client.close(); } catch { /* ignore */ }
  }
}
