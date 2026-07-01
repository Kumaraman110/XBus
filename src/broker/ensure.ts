/**
 * ensureBroker() — the shared, race-safe "connect or start" entry (beta.4,
 * ADR 0012 Decision 7). The MCP server, lifecycle hooks, the CLI, and admin
 * clients all call this so a user never has to run `xbus start`.
 *
 * State machine (see tests/unit/ensure-broker.test.ts):
 *   1. probe the endpoint → reachable ⇒ REUSE (verify compatibility, return).
 *   2. unreachable → checkSingleton:
 *        'already_running' ⇒ re-probe + connect (someone bound between steps).
 *        'acquired' | 'stale_cleared' ⇒ spawn ONE detached broker, await handshake.
 *        'contended' ⇒ we LOST the race — do NOT spawn; bounded backoff + re-probe
 *                      until the winner answers (or we time out → degraded).
 *   3. an incompatible reachable broker is surfaced DEGRADED — never force-restarted
 *      (ADR 0008 one-owner; the user must act).
 *   4. anything that fails returns a DEGRADED result — ensureBroker NEVER throws, so
 *      a hook can silently degrade and Claude still starts.
 *
 * Every collaborator (probe / checkSingleton / spawnBroker / verifyCompatible /
 * sleep / now) is injected, so the logic is deterministic under test and opens no
 * socket and forks no process there. `ensureBrokerDefault()` wires the real ones.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { SingletonProbe } from './singleton.js';
import { probeExisting, checkSingleton } from './singleton.js';
import { defaultEndpoint } from '../ipc/transport.js';

export interface EnsureBrokerOk {
  ok: true;
  endpoint: string;
  /** A broker is reachable now. */
  isRunning: true;
  /** True iff THIS call spawned the broker (false ⇒ reused an existing one). */
  launched: boolean;
}
export interface EnsureBrokerDegraded {
  ok: false;
  degraded: true;
  /** Machine-readable cause: 'incompatible' | 'start_timeout' | 'spawn_failed' | 'unreachable' | 'error'. */
  reason: string;
  detail: string;
}
export type EnsureBrokerResult = EnsureBrokerOk | EnsureBrokerDegraded;

export interface EnsureBrokerDeps {
  dataDir: string;
  endpoint: string;
  /** Is a broker answering on the endpoint right now? (bounded; never throws ideally). */
  probe: (endpoint: string) => Promise<boolean>;
  /** The singleton arbiter (singleton.ts checkSingleton). */
  checkSingleton: (dataDir: string, endpoint: string) => Promise<SingletonProbe>;
  /** Start ONE detached broker process for this dataDir. Resolves once the spawn is
   *  issued (NOT once it is reachable — that is observed via `probe`). */
  spawnBroker: (dataDir: string) => Promise<void>;
  /** Verify a reachable broker is compatible (protocol/STP/schema). Default ok. */
  verifyCompatible: (endpoint: string) => Promise<{ ok: boolean; reason?: string; detail?: string }>;
  /** Injected delay (no real timer under test). */
  sleep: (ms: number) => Promise<void>;
  /** Monotonic clock (ms) for the bounded wait loop. */
  now: () => number;
  /** Max time to wait for a spawned/contended broker to answer before degrading. */
  handshakeTimeoutMs: number;
  /** Backoff ceiling for the re-probe loop. */
  maxBackoffMs: number;
  log: (msg: string) => void;
}

/** Initial backoff step; doubles up to maxBackoffMs. */
const INITIAL_BACKOFF_MS = 25;

async function safeProbe(deps: EnsureBrokerDeps): Promise<boolean> {
  try { return await deps.probe(deps.endpoint); } catch { return false; }
}

/** Poll until the endpoint answers or the deadline passes. Bounded; never hangs. */
async function waitUntilReachable(deps: EnsureBrokerDeps): Promise<boolean> {
  const deadline = deps.now() + deps.handshakeTimeoutMs;
  let backoff = INITIAL_BACKOFF_MS;
  // First check immediately, then back off.
  if (await safeProbe(deps)) return true;
  while (deps.now() < deadline) {
    await deps.sleep(Math.min(backoff, deps.maxBackoffMs));
    if (await safeProbe(deps)) return true;
    backoff = Math.min(backoff * 2, deps.maxBackoffMs);
  }
  return false;
}

/** If a broker is reachable, return its (compatibility-checked) ok/degraded result;
 *  null if it is not reachable (caller proceeds to start/contend). */
async function tryReuse(deps: EnsureBrokerDeps, launched: boolean): Promise<EnsureBrokerResult | null> {
  if (!(await safeProbe(deps))) return null;
  let compat: { ok: boolean; reason?: string; detail?: string };
  try { compat = await deps.verifyCompatible(deps.endpoint); }
  catch (e) { return { ok: false, degraded: true, reason: 'error', detail: `compatibility check failed: ${(e as Error).message}` }; }
  if (!compat.ok) {
    // Reachable but incompatible — NEVER force-restart (ADR 0008). Surface degraded.
    return { ok: false, degraded: true, reason: compat.reason ?? 'incompatible', detail: compat.detail ?? 'a running broker is incompatible with this build; stop it and retry with a single version' };
  }
  return { ok: true, endpoint: deps.endpoint, isRunning: true, launched };
}

export async function ensureBroker(deps: EnsureBrokerDeps): Promise<EnsureBrokerResult> {
  try {
    // 1) REUSE — a reachable, compatible broker short-circuits everything.
    const reused = await tryReuse(deps, false);
    if (reused) return reused;

    // 2) Not reachable → consult the singleton arbiter.
    let probe: SingletonProbe;
    try { probe = await deps.checkSingleton(deps.dataDir, deps.endpoint); }
    catch (e) { return { ok: false, degraded: true, reason: 'error', detail: `singleton check failed: ${(e as Error).message}` }; }

    if (probe.outcome === 'already_running') {
      // Someone bound between our probe and the check — wait for it + connect.
      if (await waitUntilReachable(deps)) {
        const r = await tryReuse(deps, false);
        if (r) return r;
      }
      return { ok: false, degraded: true, reason: 'unreachable', detail: 'a broker registered as already-running but did not answer in time' };
    }

    if (probe.outcome === 'contended') {
      // We LOST the start race — another process is bringing a broker up. Do NOT
      // spawn a second one; back off and connect to the winner.
      deps.log('ensureBroker: broker contended; awaiting the winning broker');
      if (await waitUntilReachable(deps)) {
        const r = await tryReuse(deps, false);
        if (r) return r;
      }
      return { ok: false, degraded: true, reason: 'start_timeout', detail: 'another broker was starting but did not become reachable in time' };
    }

    // 'acquired' | 'stale_cleared' → we are responsible for starting exactly one.
    try { await deps.spawnBroker(deps.dataDir); }
    catch (e) { return { ok: false, degraded: true, reason: 'spawn_failed', detail: `failed to start the broker: ${(e as Error).message}` }; }

    if (await waitUntilReachable(deps)) {
      const r = await tryReuse(deps, true);
      if (r) return r;
    }
    return { ok: false, degraded: true, reason: 'start_timeout', detail: 'the broker was started but did not become reachable in time' };
  } catch (e) {
    // Absolute backstop: ensureBroker NEVER throws (hook silent-degrade contract).
    return { ok: false, degraded: true, reason: 'error', detail: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Production wiring — the real collaborators. Kept here (not inlined into
// ensureBroker) so the core state machine stays injectable + deterministic.
// ---------------------------------------------------------------------------

/** Resolve the compiled broker CLI entry (`dist/cli/main.js`) relative to THIS
 *  compiled module (`dist/broker/ensure.js`). Works from any cwd, no PATH. */
function brokerEntryScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // <root>/dist/broker
  return path.resolve(here, '..', 'cli', 'main.js');         // <root>/dist/cli/main.js
}

/**
 * Detach-spawn ONE broker process: `node <dist/cli/main.js> start`. The child is
 * fully detached (its own process group, stdio ignored) and unref'd so the parent
 * (an MCP server, hook, or CLI) can exit without killing the broker. The broker's
 * own singleton bind is the final arbiter, so even if two callers race past the
 * checkSingleton gate, only one survives `start` (the other gets BROKER_CONTENDED
 * and exits) — we never end up with two live brokers.
 */
export function spawnDetachedBroker(dataDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(process.execPath, [brokerEntryScript(), 'start'], {
        cwd: dataDir,
        env: { ...process.env, XBUS_DATA_DIR: dataDir },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', reject);
      // Resolve as soon as the spawn is issued; readiness is observed via probe.
      child.unref();
      resolve();
    } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
  });
}

/** Verify a reachable broker is COMPATIBLE by running the version hello over a
 *  throwaway connection. A typed VERSION_INCOMPATIBLE / PROTOCOL_MISMATCH (or any
 *  handshake failure) ⇒ not ok — surfaced degraded, NEVER force-restarted. The
 *  IpcClient + doHello are dynamically imported to avoid a static cycle. */
async function verifyCompatibleDefault(endpoint: string, dataDir: string): Promise<{ ok: boolean; reason?: string; detail?: string }> {
  const [{ IpcClient }, { doHello }, rootSecretMod, { ComponentRole }] = await Promise.all([
    import('../ipc/client.js'),
    import('../ipc/hello.js'),
    import('../ipc/root-secret.js'),
    import('../identity/components.js'),
  ]);
  let rootSecret: Buffer | undefined;
  try { rootSecret = rootSecretMod.loadOrCreateRootSecret(dataDir); } catch { rootSecret = undefined; }
  const client = new IpcClient(endpoint, rootSecret ? { rootSecret, helloIdentity: { claimedRole: 'mcp' } } : { helloIdentity: { claimedRole: 'mcp' } });
  try {
    await client.connect();
    await doHello(client, ComponentRole.MCP);
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: string }).code;
    const incompat = code === 'XBUS_VERSION_INCOMPATIBLE' || code === 'XBUS_PROTOCOL_MISMATCH';
    return { ok: false, reason: incompat ? 'incompatible' : 'error', detail: (e as Error).message };
  } finally {
    try { client.close(); } catch { /* ignore */ }
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); if (typeof t.unref === 'function') t.unref(); });

/**
 * Production ensureBroker: wires the real probe / singleton / detached-spawn /
 * compatibility collaborators for a data dir. This is what the MCP server, hooks,
 * and CLI call. Still returns a degraded result instead of throwing.
 */
export function ensureBrokerDefault(dataDir: string, opts: { handshakeTimeoutMs?: number; log?: (m: string) => void } = {}): Promise<EnsureBrokerResult> {
  const endpoint = defaultEndpoint(dataDir);
  return ensureBroker({
    dataDir,
    endpoint,
    probe: (ep) => probeExisting(ep, 1200),
    checkSingleton,
    spawnBroker: spawnDetachedBroker,
    verifyCompatible: (ep) => verifyCompatibleDefault(ep, dataDir),
    sleep: realSleep,
    now: () => Date.now(),
    handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 8000,
    maxBackoffMs: 250,
    log: opts.log ?? (() => {}),
  });
}
