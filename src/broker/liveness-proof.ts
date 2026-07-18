/**
 * Broker liveness proof (beta.10 Stage 0, Part B) — shared with the beta.9 recycled-PID hotfix.
 *
 * PROBLEM (ADR-0007 violation in shipped beta.9): the state file records a broker's PID, but
 * a hard-killed broker leaves the file behind and the OS can recycle that PID to an unrelated
 * SAME-USER process. `pidIsAlive` + owner-hash then wrongly conclude "our broker is alive",
 * which can (a) SIGTERM the innocent recycled process on the stop path, or (b) wedge auto-restart
 * on the singleton/acquire path. See docs / DEFECT-beta9-recycled-pid.
 *
 * FIX: prove the process recorded in the state file is REALLY our broker — not just that SOME
 * process holds that PID. Two independent arms, either sufficient for a POSITIVE proof of life:
 *   1. OS process-CREATION-time of the PID matches the creation-time marker recorded at start.
 *   2. the endpoint completes our STP handshake (a squatter answering a bare connect cannot).
 * A start-time MISMATCH is a POSITIVE proof-of-recycle. When neither arm can conclude, the verdict
 * is INCONCLUSIVE — and the two callers must fail closed in OPPOSITE directions (see below).
 *
 * THREE verdicts, NOT a boolean (the correctness core — Adversarial S0-B-DIRECTION):
 *   - PROVEN_LIVE_BROKER      pid alive AND (creation-time matches OR handshake completes)
 *   - PROVEN_DEAD_OR_RECYCLED pid dead, OR pid alive but creation-time positively MISMATCHES
 *   - INCONCLUSIVE            cannot read creation-time AND handshake did not complete
 *
 * Per-caller fail-closed mapping:
 *   classifyShutdown (KILL path):  PROVEN_LIVE->ipc ; DEAD/RECYCLED->none(stale) ; INCONCLUSIVE->never signal
 *   checkSingleton   (ACQUIRE):    PROVEN_LIVE->already_running ; DEAD/RECYCLED->stale_cleared ; INCONCLUSIVE->treat as running (do NOT spawn a duplicate)
 *
 * Every OS read is BOUNDED + fail-safe (mirrors unmanaged.ts / acl.ts idiom): a slow/absent tool
 * or a parse error yields "unknown", never a hang and never a false positive. All seams are
 * injectable so unit tests are deterministic without a real PID collision or a slow host.
 */
import { execFileSync } from 'node:child_process';
import { pidIsAlive } from './state-file.js';

export type LivenessVerdict = 'proven_live_broker' | 'proven_dead_or_recycled' | 'inconclusive';

/** Default bound for an OS process-info read (same class as the icacls/tasklist bounds). */
export const LIVENESS_READ_TIMEOUT_MS = 2000;

/** Injectable seams so the truth table is unit-testable without real PIDs/hosts/brokers. */
export interface LivenessDeps {
  /** Read the OS process-CREATION time for `pid` as an epoch-ms number, or null if unknown
   *  (no such process / unreadable / timeout). MUST be bounded + never throw. */
  readCreationTimeMs?: (pid: number) => number | null;
  /** True iff `pid` currently maps to a live process (signal-0 probe). */
  pidAlive?: (pid: number) => boolean;
  /** Complete our STP handshake against `endpoint`; true only on a valid broker handshake.
   *  A bare connect by a non-broker squatter must return false. Returns undefined when no
   *  probe is available (arm not consulted). Optional — the creation-time arm is primary. */
  handshakeOk?: (endpoint: string) => boolean | undefined;
  /** Tolerance (ms) for comparing recorded vs re-read creation time (clock/precision jitter). */
  toleranceMs?: number;
}

/**
 * Read a process's OS creation time (epoch ms), bounded + fail-safe. NON-INVASIVE: reads only
 * the process table's start-time field, never another process's env/memory/handles.
 *  - Windows: PowerShell `(Get-Process -Id <pid>).StartTime` as round-trippable UTC ticks.
 *  - POSIX:   `ps -o lstart= -p <pid>` (absolute start time), parsed to epoch ms.
 * Returns null on any failure (absent tool, no such pid, timeout, parse error).
 * BOTH the recorded marker (host.ts) and this reader MUST use the SAME source so a real
 * broker round-trips to an EQUAL value (guards the inverse-failure S0-B11).
 */
export function osProcessCreationTimeMs(pid: number, timeoutMs = LIVENESS_READ_TIMEOUT_MS): number | null {
  try {
    if (process.platform === 'win32') {
      // Emit UTC ticks (culture/timezone-invariant) so record==read regardless of locale.
      const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [int64]($p.StartTime.ToUniversalTime().Ticks)`;
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!/^\d+$/.test(out)) return null;
      // .NET ticks (100ns since 0001-01-01 UTC) → epoch ms. 621355968000000000 ticks = Unix epoch.
      const ticks = BigInt(out);
      const epochMs = Number((ticks - 621355968000000000n) / 10000n);
      return Number.isFinite(epochMs) ? epochMs : null;
    }
    // POSIX: absolute start time, locale-stable enough for equality within tolerance.
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null; // fail-safe: unknown, never throw, never a false positive
  }
}

/**
 * Classify whether the process recorded in a state file is truly our live broker.
 * @param pid            the PID recorded in the state file
 * @param recordedCreationMs the OS creation time recorded when the broker started (epoch ms), or
 *                       null/undefined if the state file predates this field (old file).
 * @param endpoint       the broker endpoint, for the optional handshake arm.
 */
export function classifyLiveness(
  pid: number,
  recordedCreationMs: number | null | undefined,
  endpoint?: string,
  deps: LivenessDeps = {},
): LivenessVerdict {
  const alive = (deps.pidAlive ?? pidIsAlive)(pid);
  if (!alive) return 'proven_dead_or_recycled'; // dead PID: safe to treat as gone

  const tol = deps.toleranceMs ?? 1000;
  const readCreation = deps.readCreationTimeMs ?? ((p: number) => osProcessCreationTimeMs(p));
  const nowCreation = readCreation(pid);

  // Arm 1 — creation-time comparison (only when BOTH the recorded marker and the fresh read
  // are available; a positive mismatch is proof-of-recycle, a match is proof-of-life).
  if (recordedCreationMs != null && nowCreation != null) {
    if (Math.abs(nowCreation - recordedCreationMs) <= tol) return 'proven_live_broker';
    return 'proven_dead_or_recycled'; // alive PID, different process => recycled
  }

  // Arm 2 — STP handshake (authoritative when available): a real broker completes it; a
  // squatter that merely accepts a connection does not.
  if (endpoint && deps.handshakeOk) {
    const hs = deps.handshakeOk(endpoint);
    if (hs === true) return 'proven_live_broker';
    if (hs === false) return 'proven_dead_or_recycled'; // alive PID not speaking our protocol
    // hs === undefined => probe unavailable => fall through to inconclusive
  }

  // Neither arm could conclude (old state file w/o marker AND no/again-inconclusive handshake):
  // cannot prove either way. Callers fail closed in OPPOSITE directions.
  return 'inconclusive';
}
