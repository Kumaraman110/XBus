# Architecture: the XBus capability model

> **Status: DESIGN_COMPLETE (planning).** Canonical plan:
> [`docs/roadmap/universal-xbus.md`](../roadmap/universal-xbus.md) §3. Baseline
> `v0.1.0-beta.2` / `69b191f` untouched.

A versioned `AgentCapabilities` descriptor layered **on top of** the already-shipping
`identity/components.ts` MATRIX. The MATRIX stays the **sole authority**; the descriptor
only declares which already-allowed operations a concrete agent uses + the six capability
groups, so the broker can derive readiness and emit diagnostics.

```ts
export type CapState = 'supported' | 'unsupported' | 'unknown';   // explicit tri-state
export const CAPABILITY_DESCRIPTOR_VERSION = 1 as const;

export interface AgentCapabilities {
  readonly capVersion: number;                                    // descriptor schema version, NOT proto
  readonly role: 'mcp' | 'hook' | 'transport' | 'cli' | 'admin';  // maps to ComponentRole; MATRIX still consulted
  readonly identity:  { resolvesIdentity: CapState; stableAcrossResume: CapState };
  readonly receive:   { hookCheckpoint: CapState; live: CapState; manualPull: CapState };
  readonly messaging: { send: CapState; reply: CapState; ack: CapState; listInbox: CapState };
  readonly lifecycle: { reportsReadiness: CapState; listSessions: CapState; changeAlias: CapState; shutdown: CapState };
  readonly security:  { peerFenceApplied: CapState; metadataDenylistEnforced: CapState };
  readonly execution: { tier: 1|2|3|4|5|'unknown'; betweenTurnExecution: CapState };
  readonly ext?: Readonly<Record<string, unknown>>;               // unknown fields preserved + ignored, never error
}
```

## Rules

- **Wire-additive:** rides inside the existing `HelloInfo.capabilities: string[]` as a
  `cap:v1:<base64url(json)>` token. Bare legacy grants still work; an unaware broker
  ignores the token and falls back — no error, no downgrade. No protocol/STP/schema bump.
- **Tri-state:** `unknown` is fail-closed for authorization (like `unsupported`) but
  reported distinctly in content-free diagnostics — a missing field is never read as a
  capability.
- **Reported vs verified:** `role` + ops verified against the MATRIX at call time;
  readiness re-derived via `resolveReadiness`; `execution.tier` advisory only. **No claim
  from platform name alone.**
- **Narrow-never-widen:** `effectiveOps = MATRIX[role] ∩ {supported}` — always a subset.
- **Roles are capability classes, not vendor tags:** generic-CLI → `role:'cli'`;
  headless-worker → `role:'hook'`. A verb no role grants is a MATRIX change (explicit,
  reviewed, fail-closed) — never a descriptor field.

## Operation set (ground truth at `69b191f`)

`identity/components.ts` `Operation` has **12** members: `register, send,
pull_hook_checkpoint, mark_injected, ack, reply, list_inbox, list_sessions, get_metrics,
dead_letter, change_alias, shutdown`. (An adversarial draft mis-stated this as 10; the
descriptor maps over all 12.)
