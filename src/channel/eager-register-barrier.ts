/**
 * BETA.10 Phase B — the eager-register TEST BARRIER.
 *
 * The deferred eager-register fire-and-forget race (ADR 0036) has a false-emission window that is
 * NOT reproducible by a real-latency cold-start run: the Stop hook fails-closed while the broker is
 * still starting (checkpoint-hook.ts), so the only window in which a plugin-loaded session can be
 * mis-diagnosed PLUGIN_NOT_LOADED/DEGRADED_HOOK_ONLY is the ~ms tail AFTER the broker is reachable
 * but BEFORE the MCP server's `register_session` commits the mcp `component_instances` row.
 *
 * To adjudicate that race DETERMINISTICALLY (instead of drawing a go/no-go from a false-negative
 * clean run), this env-gated barrier holds the eager register for a controlled interval so a forced
 * Stop is guaranteed to land while mcpEver=false. It is:
 *   - a strict NO-OP unless XBUS_TEST_EAGER_REGISTER_DELAY_MS is set to a positive integer, and
 *   - applied ONLY on the eager (notifications/initialized) path — never on the tool-call path,
 *     which must stay fast — so production behavior is byte-for-byte unchanged when the env is unset.
 *
 * It changes NO wire, schema, classifier, or exit-code contract; it only inserts an optional,
 * test-controlled delay into one already-async code path.
 */

/** The single env var that arms the barrier. Unset ⇒ no delay ⇒ production behavior. */
export const EAGER_REGISTER_DELAY_ENV = 'XBUS_TEST_EAGER_REGISTER_DELAY_MS';

/** Bounded ceiling so a test seam can never be turned into an unbounded broker hold. */
const MAX_DELAY_MS = 60_000;

/**
 * Parse the configured delay from an env map. Returns a clamped, non-negative integer ms; returns 0
 * for unset / empty / zero / negative / non-numeric input (so the barrier never sleeps a NaN or a
 * negative interval, and stays a no-op by default).
 */
export function eagerRegisterDelayMs(env: NodeJS.ProcessEnv | Record<string, string | undefined>): number {
  const raw = env[EAGER_REGISTER_DELAY_ENV];
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_DELAY_MS);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface EagerRegisterBarrierOptions {
  /** True only on the eager (notifications/initialized) registration path. */
  eager: boolean;
  /** Injected sleep (deterministic in tests); defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Env source; defaults to process.env. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

/**
 * Apply the barrier: sleep for the configured interval iff we are on the eager path AND the env arms
 * it. On the tool-call path, or when the env is unset, this returns immediately without sleeping.
 */
export async function applyEagerRegisterBarrier(opts: EagerRegisterBarrierOptions): Promise<void> {
  if (!opts.eager) return;
  const ms = eagerRegisterDelayMs(opts.env ?? process.env);
  if (ms <= 0) return;
  await (opts.sleep ?? defaultSleep)(ms);
}
