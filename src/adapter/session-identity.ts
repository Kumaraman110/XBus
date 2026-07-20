/**
 * BETA.10 WS4 — provider adapter boundary for HOST-AGENT lifecycle. The AgenTel CORE (identity,
 * messaging, persistence, conversations, Collections, work items) is provider-NEUTRAL: it never
 * reads a host-agent's env vars or on-disk layout directly. Host-specific concerns —
 *   - how a runtime session id is discovered,
 *   - where a host stores its per-session transcripts (for dormant-session discovery),
 *   - the host's lifecycle vocabulary (startup/resume/clear/compact/stop),
 *   - the host's wake capability,
 * live behind THIS interface. A concrete adapter (ClaudeCodeAdapter) reads Claude Code's
 * CLAUDE_CODE_SESSION_ID + ~/.claude/projects; a FakeAdapter provides deterministic, host-neutral
 * values so the identity/delivery/reclaim/restart/reply conformance suite runs WITHOUT any
 * Claude-specific identifier. This is NOT a claim of Codex production support — it is the seam that
 * makes such support trivial + fully testable later.
 */

/** How the host reports the current runtime session id (a DISPOSABLE per-process instance id). */
export interface SessionIdentitySource {
  /** The host's name (diagnostics only; never an authority input). */
  readonly hostKind: string;
  /**
   * Resolve the current runtime session id. Returns null when the host has not provided one
   * (the caller decides whether that is fatal — the MCP server hard-fails, a hook falls back to
   * its stdin `session_id`). NEVER invents an id.
   */
  resolveSessionId(fallback?: string | null): string | null;
  /** The host's per-session transcript root, for dormant-session discovery. null = none. */
  transcriptsRoot(): string | null;
  /** Whether this host can be woken (re-activated) out-of-band. */
  readonly canWake: boolean;
}

/** Claude Code adapter — the ONLY place the core learns Claude's env + on-disk layout. */
export class ClaudeCodeAdapter implements SessionIdentitySource {
  readonly hostKind = 'claude-code';
  readonly canWake = true;
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly homedir: () => string = () => require('node:os').homedir() as string,
  ) {}
  resolveSessionId(fallback: string | null = null): string | null {
    return this.env.CLAUDE_CODE_SESSION_ID || fallback || null;
  }
  transcriptsRoot(): string | null {
    const override = this.env.XBUS_CLAUDE_PROJECTS_DIR;
    if (override) return override;
    return require('node:path').join(this.homedir(), '.claude', 'projects');
  }
}

/**
 * Host-neutral FAKE adapter for conformance testing: identity/delivery/reclaim/restart/reply can be
 * exercised WITHOUT any Claude-specific identifier or on-disk layout. Deterministic + injectable.
 */
export class FakeAdapter implements SessionIdentitySource {
  readonly hostKind = 'fake';
  constructor(
    private sessionId: string | null,
    readonly canWake: boolean = false,
    private readonly root: string | null = null,
  ) {}
  resolveSessionId(fallback: string | null = null): string | null { return this.sessionId ?? fallback ?? null; }
  transcriptsRoot(): string | null { return this.root; }
  /** Test helper: simulate a host reporting a new/absent id (reconnect / disconnect). */
  setSessionId(id: string | null): void { this.sessionId = id; }
}
