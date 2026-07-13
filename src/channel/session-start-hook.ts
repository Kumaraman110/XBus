/**
 * SessionStart hook entrypoint (beta.5 Phase 1; ADR 0013 D2 / ADR 0020 Q1).
 *
 * Configured as a Claude Code `SessionStart` hook matching ALL sources
 * (startup/resume/clear/compact). On fire it:
 *   1. reads the hook JSON from stdin (documented inputs only),
 *   2. connects to the broker (auto-starting it via ensureBrokerDefault — the first
 *      session of the machine boots the single broker), registers this session as a
 *      `hook` component (joins the current epoch; does NOT claim the binding — ADR 0003),
 *   3. sends ONE `announce_session` frame so the session is visible in the control plane
 *      and a single lifecycle ledger event is recorded,
 *   4. exits 0.
 *
 * NON-NEGOTIABLE (I5 / ADR 0012 D7): this hook NEVER blocks Claude. Malformed input, an
 * incompatible Node, an unreachable/failing broker, or a timeout all degrade to a short,
 * BOUNDED stderr note and `exit 0` so Claude Code still starts. It performs NO delivery
 * and prints NO additionalContext — visibility is a side effect, never a gate. Product
 * INSTALL and BROKER ENTRY remain fail-CLOSED on Node < 22.13 (assertSupportedNode there);
 * this hook is the one place that must stay fail-OPEN.
 */
import { v7 as uuidv7 } from 'uuid';
import { IpcClient } from '../ipc/client.js';
import { doHello } from '../ipc/hello.js';
import { ComponentRole } from '../identity/components.js';
import { defaultEndpoint } from '../ipc/transport.js';
import { resolveDataDir } from './server.js';
import { loadOrCreateRootSecret } from '../ipc/root-secret.js';
import { ensureBrokerDefault } from '../broker/ensure.js';
import { computeProjectId } from '../identity/project.js';

/** Documented SessionStart hook inputs (code.claude.com/docs/en/hooks). All optional
 *  here so malformed/partial JSON never throws — we degrade instead. */
export interface SessionStartInput {
  hook_event_name?: string;
  session_id?: string;
  source?: string;
  cwd?: string;
  transcript_path?: string;
  agent_type?: string;
  session_title?: string;
}

/** Bounded stderr note — capped so a hostile/huge value can't flood the terminal. */
function note(msg: string): void {
  try { process.stderr.write(`[xbus] ${msg.slice(0, 200)}\n`); } catch { /* ignore */ }
}

/** The announce leg, isolated so main() can guarantee exit 0 around it. Returns quietly
 *  on any degradation (no throw escapes). A short per-call timeout bounds a hung broker. */
export async function runSessionStart(
  input: SessionStartInput,
  cfg: { endpoint: string; rootSecret: Buffer; requestTimeoutMs?: number },
): Promise<{ announced: boolean; reason?: string }> {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || input.session_id;
  if (!sessionId) return { announced: false, reason: 'no-session-id' };
  const source = input.source ?? 'startup';
  const cwd = input.cwd || process.cwd();

  const client = new IpcClient(cfg.endpoint, {
    requestTimeoutMs: cfg.requestTimeoutMs ?? 4000,
    rootSecret: cfg.rootSecret,
    helloIdentity: { claimedRole: 'hook', claimedSessionId: sessionId },
  });
  try {
    await client.connect();
  } catch {
    return { announced: false, reason: 'broker-unreachable' };
  }
  try {
    await doHello(client, ComponentRole.HOOK);
    // Register as a HOOK component (joins the session's current epoch; never claims the
    // binding or bumps the epoch — ADR 0003). This is the same idempotent-join the
    // checkpoint hook performs, so an already-registered session is unaffected.
    await client.request('register_session', {
      sessionId, instanceId: uuidv7(), processId: process.pid,
      projectId: process.env.XBUS_PROJECT_ID ?? computeProjectId(cwd), cwd,
      receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: ComponentRole.HOOK,
    });
    // ONE announce frame — visibility + exactly one lifecycle ledger event (broker-side).
    const ack = await client.request('announce_session', {
      source,
      cwd,
      ...(input.transcript_path !== undefined ? { transcriptPath: input.transcript_path } : {}),
      ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
    });
    if (ack.frameType === 'error') {
      return { announced: false, reason: (ack.payload as { code?: string }).code ?? 'announce-error' };
    }
    return { announced: true };
  } catch (e) {
    return { announced: false, reason: (e as Error).message };
  } finally {
    client.close();
  }
}

export async function main(): Promise<void> {
  // Read stdin fully; a broken/absent stream must not throw.
  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
  } catch { /* degrade below */ }
  let input: SessionStartInput;
  try {
    input = JSON.parse(raw || '{}') as SessionStartInput;
  } catch {
    input = {};
  }

  const dataDir = resolveDataDir();
  const endpoint = defaultEndpoint(dataDir);
  // The root-secret load can THROW (malformed/unreadable/concurrently-replaced secret).
  // Degrade → exit 0 (visibility skipped this session; Claude proceeds normally).
  let rootSecret: Buffer;
  try {
    rootSecret = loadOrCreateRootSecret(dataDir);
  } catch {
    note('session not announced (secret load failed); continuing');
    process.exit(0);
  }
  // Zero-friction broker auto-start (ADR 0012 D7): best-effort + bounded. If it degrades,
  // the connect below simply fails closed and we exit 0 — Claude is never blocked.
  try { await ensureBrokerDefault(dataDir); } catch { /* connect will degrade */ }
  try {
    const r = await runSessionStart(input, { endpoint, rootSecret });
    if (!r.announced && r.reason) note(`session not announced (${r.reason}); continuing`);
  } catch (e) {
    note(`session announce degraded (${(e as Error).message}); continuing`);
  }
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('session-start-hook.js')) {
  void main();
}
