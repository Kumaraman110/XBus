/**
 * Broker singleton acquisition (reliability contract §14). Exactly one broker is
 * authoritative for one canonical user-data directory; others connect or fail
 * with a typed, actionable result.
 *
 * Layered guard (not PID-file alone):
 *  1. If a reachable broker answers a hello on the endpoint -> ALREADY_RUNNING
 *     (the contender should connect, not start).
 *  2. Else attempt to listen. OS named-pipe/UDS bind gives atomic exclusivity:
 *     EADDRINUSE -> a broker is starting/bound but not yet answering -> typed
 *     CONTENDED (retry with bounded backoff or fail).
 *  3. On success this process is authoritative; it writes the state file.
 *  4. Stale state file (dead pid / not reachable) is ignored for binding but
 *     surfaced in diagnostics.
 */
import net from 'node:net';
import { readStateFile, pidIsAlive } from './state-file.js';

export type SingletonOutcome = 'acquired' | 'already_running' | 'contended' | 'stale_cleared';

export interface SingletonProbe {
  outcome: SingletonOutcome;
  detail: string;
  /** endpoint of the reachable existing broker, if already_running. */
  endpoint?: string;
}

/** Probe whether a broker is already reachable on the endpoint (bounded). */
export function probeExisting(endpoint: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(v); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); finish(true); });
    sock.once('error', () => { clearTimeout(timer); finish(false); });
  });
}

/**
 * Decide singleton status for a data dir + endpoint BEFORE attempting to listen.
 * Does not bind — the caller binds and maps EADDRINUSE to 'contended'.
 */
export async function checkSingleton(dataDir: string, endpoint: string): Promise<SingletonProbe> {
  const reachable = await probeExisting(endpoint);
  if (reachable) {
    return { outcome: 'already_running', detail: 'a broker is already serving this data directory; connect to it', endpoint };
  }
  const state = readStateFile(dataDir);
  if (state && pidIsAlive(state.pid)) {
    // pid alive but endpoint not answering yet -> a broker is starting up.
    return { outcome: 'contended', detail: `broker pid ${state.pid} is starting (endpoint not yet answering)` };
  }
  if (state && !pidIsAlive(state.pid)) {
    return { outcome: 'stale_cleared', detail: `stale broker state (pid ${state.pid} dead); safe to acquire` };
  }
  return { outcome: 'acquired', detail: 'no existing broker; acquiring' };
}
