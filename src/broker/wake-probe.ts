/**
 * BETA.11 (ADR 0038) — broker-owned host WAKE-PROBE record.
 *
 * WHY: `ready_wakeable` (routing-class.ts) may be claimed ONLY when AgenTel has PROVEN, on THIS
 * host, that the resident `asyncRewake` rewaker actually wakes an idle session (exit-2 → the
 * documented system reminder → a checkpoint pull). Whether that works is host-dependent and NOT
 * guaranteed by the Claude Code docs (adversarial verdict; ADR 0038). So the wake capability is a
 * HOST FACT, recorded by `doctor`'s spawn/wake probe — NEVER a per-session client assertion.
 *
 * SECURITY (review MAJOR-2 / MINOR-1): the probe is BROKER-OWNED. A connected client cannot set it
 * (there is no wire frame that writes it here); it is seeded at broker construction and updated only
 * by the in-process doctor/host path. Absent proof ⇒ `{proven:false}` (the honest default) ⇒ every
 * `ready_checkpoint` session resolves to `degraded_hook_only`, never `ready_wakeable`. We never
 * over-claim; we prove per host or we tell the truth.
 *
 * NO SCHEMA CHANGE: this is an in-memory, broker-lifetime fact (the probe is re-run per host/boot;
 * it is not durable session state). It carries no bodies, no secrets — only a boolean + a short
 * operator detail string.
 */
import type { WakeProbe } from './routing-class.js';

/** Holds the current host wake-probe verdict for the broker's lifetime. Defaults to unproven. */
export class WakeProbeStore {
  private probe: WakeProbe;
  /** The Claude Code version the broker is running against (for version-bound proof validity). */
  private readonly runningVersion: string | undefined;

  constructor(initial?: WakeProbe, runningVersion?: string) {
    // Honest default: until a real host probe proves the wake, we are NOT wakeable.
    this.probe = initial ?? { proven: false, detail: 'wake capability not yet probed on this host' };
    this.runningVersion = runningVersion;
  }

  /**
   * The EFFECTIVE host wake-probe. A stored `proven` proof is only honored if it was observed on the
   * SAME `claude --version` the broker is running against now (arch review E: an asyncRewake contract
   * can change between CC releases). On a version mismatch we downgrade to unproven (re-probe needed),
   * so we never keep claiming `ready_wakeable` on a host where a CC update silently broke the wake.
   */
  get(): WakeProbe {
    if (this.probe.proven && this.runningVersion && this.probe.claudeVersion && this.probe.claudeVersion !== this.runningVersion) {
      return { proven: false, detail: `wake proof stale: probed on ${this.probe.claudeVersion}, running ${this.runningVersion} — re-probe required` };
    }
    return this.probe;
  }

  /**
   * Record a host probe result. Called ONLY by the in-process doctor/host path (never from a client
   * frame). `proven` must be true ONLY if a real idle-session asyncRewake exit-2 wake was observed.
   */
  record(probe: WakeProbe): void {
    this.probe = {
      proven: probe.proven === true,
      ...(probe.detail !== undefined ? { detail: probe.detail } : {}),
      ...(probe.claudeVersion !== undefined ? { claudeVersion: probe.claudeVersion } : {}),
    };
  }
}
