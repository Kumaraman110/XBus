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
import { classifyLiveness, type LivenessDeps } from './liveness-proof.js';

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
export async function checkSingleton(dataDir: string, endpoint: string, deps?: LivenessDeps): Promise<SingletonProbe> {
  const reachable = await probeExisting(endpoint);
  if (reachable) {
    return { outcome: 'already_running', detail: 'a broker is already serving this data directory; connect to it', endpoint };
  }
  const state = readStateFile(dataDir);
  if (!state) return { outcome: 'acquired', detail: 'no existing broker; acquiring' };

  // Beta.10 Stage 0 (recycled-PID fix): the endpoint is NOT answering, but the recorded PID may be
  // (a) a real broker still starting up, (b) DEAD, or (c) an unrelated RECYCLED process. `pidIsAlive`
  // alone cannot tell (b)/(c) from (a). This is the ACQUIRE path, so the fail-closed direction is the
  // OPPOSITE of the shutdown path: an INCONCLUSIVE proof must NOT lead to spawning a SECOND broker
  // (split-brain) — treat it as running and defer to the bind arbiter. Only a POSITIVE proof-of-recycle
  // (or a dead pid) is safe to acquire over.
  const verdict = classifyLiveness(state.pid, state.processCreatedAt ?? null, endpoint, deps);
  if (verdict === 'proven_dead_or_recycled') {
    return { outcome: 'stale_cleared', detail: `stale broker state (pid ${state.pid} dead or recycled to an unrelated process); safe to acquire` };
  }
  if (verdict === 'inconclusive') {
    // Cannot prove the PID is NOT a live broker. Fail closed: do NOT spawn a duplicate; treat as
    // running and let the OS bind arbiter (EADDRINUSE -> contended) be the final authority.
    return { outcome: 'contended', detail: `broker pid ${state.pid} may be running (liveness inconclusive); not spawning a duplicate` };
  }
  // proven_live_broker: a real broker whose endpoint is not answering YET -> it is starting up.
  return { outcome: 'contended', detail: `broker pid ${state.pid} is starting (endpoint not yet answering)` };
}
