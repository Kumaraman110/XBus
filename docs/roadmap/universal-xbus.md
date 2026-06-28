# Universal XBus — First Long-Horizon Output (§41)

> **Status: PLANNING ONLY.** No code is pushed or merged by this document. The
> immutable public baseline `v0.1.0-beta.2` / `69b191f61491adb8aec3b7b5b9190b5710bab1ef`
> is untouched. This is the `§41` deliverable: a concrete universalization plan, not
> an adapter implementation.
>
> **Method.** Grounded by direct inspection of the live tree at `69b191f`; platform
> dossiers researched against official docs; design fanned out and then put through an
> adversarial verification pass. Where the adversarial pass made a claim that
> contradicts the source, the source wins and the correction is noted inline (see
> [Ground-truth corrections](#ground-truth-corrections-adversarial-pass-vs-source)).

---

## Recommendation (item 15, stated first)

### `PROCEED_WITH_ADAPTER_ARCHITECTURE`

XBus core is **already ~90 % vendor-neutral by construction.** Verified at `69b191f`:
`protocol/states.ts` is literally labelled *"transport-agnostic"*; the `hello`
handshake already carries `{componentRole, capabilities[]}` and computes a
compatibility verdict before registration; `broker/readiness.ts` already implements
the lifecycle/injection-safety core; `identity/components.ts` is already a fail-closed
role→operation MATRIX; and `shared/build-identity.ts` already ships a multi-axis
`compatibilityId` (`xbus-p1-stp1-s5`) **and** a six-way `classifyMixedBuild` verdict.
The Claude coupling is concentrated in `src/channel/*` + `launcher/xclaude.ts`, and the
single hard vendor dependency — `CLAUDE_CODE_SESSION_ID` — is read **only at the adapter
edge, never in the broker.**

Universalization is therefore an **additive refactor of code that already ships**, not
a redesign. Every design section preserves `xbus-p1-stp1-s5` with no wire change; the
beta.2-compatibility verifier returned `pass=true` with zero blockers.

**The single most important decision to get right:** the **tier-capping mechanism must
be implemented in the broker, not assumed.** Tier must be *derived and capped by
handshake evidence* (role + MATRIX + verified readiness hints + a real-runtime R1–R4
attestation), so a third-party adapter manifest can never self-promote past what it can
prove. Without this, the §6 tier model collapses into self-asserted labels — exactly the
overclaiming failure the adversarial pass caught. Build the cap (conformance check C7 +
a broker-side tier function) in **PR2**, before any second-party adapter exists.

**Start with:** PR1 (extract the SDK facade, zero wire change) → PR2 (land the 25-point
conformance suite *including the tier-cap and the `compatibilityId` guard*) → PR3
(refactor `channel/*` into `ClaudeCodeAdapter`, behavior-identical) → then a **generic
reference adapter** to prove vendor-neutrality → then **Codex** as the first second-party
runtime validated by a real R1–R4 log.

---

## 1. Claude-specific coupling inventory (verified at `69b191f`)

**Vendor-neutral core (zero real Claude coupling — every non-comment hit is in the
adapter set below):**

| Path | Role | Coupling |
|---|---|---|
| `src/broker/*` (14 files) | durable delivery state machine, retry, deadlines, reaper, receipts, store, daemon, controls, readiness, host | comment-only (`delivery.ts:155`) |
| `src/protocol/*` | `handshake.ts` already carries `{componentRole, capabilities[]}` + `checkCompatibility`; `states.ts` = "transport-agnostic" `DeliveryState`; `version.ts` (`PROTOCOL_VERSION=1`/`MIN=1`); `commands.ts` `FrameType` union; `errors.ts` | comment-only; `schemas.ts` reserves `claude`/`xbus` metadata prefixes (a security rule, not a leak) |
| `src/ipc/*` (10 files) | XBUS-STP transport (AES-256-GCM + HKDF + mutual-nonce, `STP_VERSION=1`), seq replay/reorder rejection, ACL, root-secret | none |
| `src/database/*` | migrations (`SCHEMA_VERSION=5`), transactional + checksum-verified + fail-closed-on-newer | one column `claude_code_version` (handled additively) |
| `src/identity/components.ts` | `ComponentRole {mcp,hook,transport,cli,admin}` × `Operation` (12) × fail-closed `MATRIX` | none — this is the *generalization target* |
| `src/observability/*` | allowlist-only, content-free, path-free metrics | none |
| `src/shared/build-identity.ts` | `compatibilityId` + `classifyMixedBuild` + provenance (already multi-axis) | none |

**The adapter boundary (real, non-comment Claude coupling — the implicit "claude-code"
adapter):**

| Path | Why it is adapter, not core |
|---|---|
| `src/channel/server.ts` | MCP entrypoint; **hard-fails if `CLAUDE_CODE_SESSION_ID` absent** — the one hard vendor identity dep |
| `src/channel/mcp-server.ts` (281 lines) | hand-rolled MCP JSON-RPC over stdio; the `xbus_*` tool surface; drives `IpcClient` |
| `src/channel/checkpoint-hook.ts` + `hook-entry.ts` | receive leg; runs as a Claude Code hook (UserPromptSubmit/Stop); injects `additionalContext` |
| `src/channel/instructions.ts` | untrusted-peer fence + marker-neutralization + bidi/zero-width stripping — **security text is vendor-NEUTRAL and must be shared by every adapter** |
| `src/launcher/xclaude.ts` | spawns `claude --plugin-dir …` |
| `.claude-plugin/plugin.json`, `hooks/hooks.json` | Claude Code packaging |

**The seam:** an adapter is anything that drives `IpcClient`:
`connect → hello(role, capabilities) → register_session → {send_message | checkpoint_pull |
ack_message | reply_message | inbox | list_sessions | signal_readiness}`. The Claude MCP
server + checkpoint hook together **are** one adapter.

**The four universalization moves:** (1) extract a thin Adapter SDK over `IpcClient`;
(2) generalize `ComponentRole`/MATRIX into a versioned capability descriptor;
(3) replace the `CLAUDE_CODE_SESSION_ID` hard-dep with an adapter-provided identity;
(4) move `channel/*` behind the contract as the first explicit adapter, behavior-identical.

---

## 2. Core vs adapter boundary

**Dependency direction (compiler-enforced via `tsconfig` project refs + an import-boundary lint):**

```
  adapter packages  ──▶  @xbus/adapter-sdk  ──▶  @xbus/core
  (claude-code, …)          (the seam)        (broker/protocol/ipc/db/identity/obs/shared)

  CORE NEVER IMPORTS THE SDK OR AN ADAPTER.   THE SDK NEVER IMPORTS AN ADAPTER.
```

- **Core** = `broker/ protocol/ ipc/ database/ identity/ observability/ shared/`.
- **`@xbus/adapter-sdk`** = `openSession()`/`BrokerFacade` (a typed facade over the
  existing `IpcClient` + `doHello`, **zero new wire verbs**) + the promoted untrusted-peer
  **fence** (lifted unchanged from `instructions.ts`, shared by all adapters).
- **`@xbus/adapter-claude-code`** = `channel/*` + `launcher/xclaude.ts` + `.claude-plugin` + `hooks`.
- **`@xbus/cli`** depends on core + SDK only (the claude-code adapter contributes its own
  install hook, to avoid a `cli → adapter` edge).

**Replacing `CLAUDE_CODE_SESSION_ID`:** core/SDK stop reading `process.env` entirely;
`openSession` takes a fully-resolved `XBusIdentity`. The claude-code adapter supplies a
`ClaudeCodeIdentitySource` that reads the env var and throws a typed `IdentityError`
(not `process.exit`) if absent; the launcher preserves the exact non-zero exit + stderr
text, so external behavior for Claude Code users is **byte-identical**.

**Two real in-core vendor leaks (inside the frozen surface) — handled additively, never renamed:**
`RegisterPayload.claudeCodeVersion` + the `sessions.claude_code_version` column get a
neutral `hostAgentVersion` alias *mapped onto the retained field/column* (renaming forces
`SCHEMA_VERSION 5→6` → out of scope); the `schemas.ts` `claude` metadata-denylist prefix
is **kept** (removing it is a security regression) and generalized to "reserved prefixes"
(it already reserves both `claude` and `xbus`).

---

## 3. Agent capability model (versioned schema)

A versioned `AgentCapabilities` descriptor layered **on top of** the existing
`components.ts` MATRIX. The MATRIX stays the **sole authority**; the descriptor only
(a) declares which already-allowed ops a concrete agent will use, and (b) declares the
six §5 groups so the broker can derive readiness + emit diagnostics.

```ts
// @xbus/core — capability/descriptor.ts.  Rides INSIDE the existing
// HelloInfo.capabilities: string[] (no wire change). Versioned independently of PROTOCOL_VERSION.
export type CapState = 'supported' | 'unsupported' | 'unknown';   // explicit tri-state
export const CAPABILITY_DESCRIPTOR_VERSION = 1 as const;

export interface AgentCapabilities {
  readonly capVersion: number;                                    // descriptor schema version, NOT proto
  readonly role: 'mcp' | 'hook' | 'transport' | 'cli' | 'admin';  // maps to ComponentRole; MATRIX still consulted
  readonly identity:  { resolvesIdentity: CapState; stableAcrossResume: CapState };
  readonly receive:   { hookCheckpoint: CapState; live: CapState; manualPull: CapState }; // live/manual UNPROVEN
  readonly messaging: { send: CapState; reply: CapState; ack: CapState; listInbox: CapState };
  readonly lifecycle: { reportsReadiness: CapState; listSessions: CapState; changeAlias: CapState; shutdown: CapState };
  readonly security:  { peerFenceApplied: CapState; metadataDenylistEnforced: CapState };
  readonly execution: { tier: 1|2|3|4|5|'unknown'; betweenTurnExecution: CapState };       // tier is REPORTED only
  readonly ext?: Readonly<Record<string, unknown>>;               // unknown fields preserved + ignored, never error
}
```

- **On the wire (no change):** the descriptor serializes into the existing
  `capabilities: string[]` as a `cap:v1:<base64url(json)>` token. Bare legacy grant
  tokens (`ack`, `live`, …) still work; a broker that does not understand `cap:v1:`
  ignores it and falls back to bare grants — no error, no downgrade.
- **Tri-state:** `unknown` is fail-closed for *authorization* (treated like
  `unsupported`) but reported *distinctly* in diagnostics, so a missing field is never
  silently read as a capability.
- **Reported vs verified:** `role` + every op are verified against the MATRIX at call
  time (`assertAllowed`); readiness is always re-derived via `resolveReadiness` (never
  trusted from a self-label); `execution.tier` is advisory only. **No claim is ever
  derived from the platform name.**
- **Narrow-never-widen:** `effectiveOps(role, declared) = MATRIX[role] ∩ {supported}` —
  always a subset. Grants can drop ops; they can never add one the role lacks.
- **Generalization:** roles are **capability classes, not vendor tags.** A generic-CLI
  adapter binds to `role:'cli'` (`{register,send,list_sessions,list_inbox}`); a
  headless-worker binds to `role:'hook'` (the receive-via-checkpoint class). A verb no
  role grants is a **MATRIX change** (explicit, reviewed, fail-closed) — never a
  descriptor field.
- **Diagnostics:** capability changes emit a content-free `CapabilityDiagnostic`
  (enums/ints/booleans only — never bodies, paths, identities, or `ext` values).

---

## 4. Universal session lifecycle model

`SessionLifecycle` is a **strict superset** of the already-shipping
`broker/readiness.ts` `Readiness` type — an extension of proven code, not a new
vocabulary. Two axes the broker keeps separate: **liveness** (`created → stopped`) and
**receive-readiness** (the existing `Readiness` axis).

```ts
export type SessionLifecycle =
  | 'created' | 'starting' | 'initializing'                 // pre-ready (liveness)
  | 'ready_manual' | 'ready_checkpoint' | 'ready_live'      // ready substates (exactly one)
  | 'busy' | 'paused' | 'dnd' | 'degraded'                  // transient operational
  | 'disconnected' | 'stopping' | 'stopped' | 'incompatible'; // exit
```

- **`Readiness` stays the wire/storage type;** `SessionLifecycle` is in-process and
  projects down via `toReadiness()`. Every existing `acceptsInjection()` / `READY_STATES`
  caller works unchanged.
- **Injectable set is unchanged:** `{ready_checkpoint, ready_live}`. All new states
  (`ready_manual`, `busy`, `paused`, `dnd`) project to **non-injectable**, inheriting the
  existing safety gate for free.
- **`DeliveryState` (per-message, `states.ts`) and `SessionLifecycle` (per-session) stay
  separate**; they touch only at the `pickup` gate (the broker fires `pickup` only into an
  injectable session).
- **Adapters never assert state** — they emit `LifecycleSignal` events + capability hints;
  the broker **derives** state via `resolveLifecycle` (the `resolveReadiness` pattern,
  "never trust a client to assert ready").
- **No-silent-manual→live:** promotion to `ready_live` requires a broker-derived verdict
  from a *structural* `hints.live` signal — never a peer message, self-assertion, or
  inferred idle.
- **`ready_manual` is NEW and UNPROVEN** — the safe valve for event-less CLIs (ready +
  ack-capable, but autonomous injection GATED; drains only on explicit `manual_pull`). It
  requires a real CLI adapter + runtime test before any Tier ≥ 2 claim is honest.

### Support tiers (§6) — *ceiling* vs *awarded*

| Tier | Internal | Max ready state | Requirements (cumulative) | Public label |
|---|---|---|---|---|
| 0 | `unsupported` | — | fails handshake | "not supported" |
| 1 | `send_only` | n/a | hello + register + send | "send-only integration (community)" |
| 2 | `manual_receive` | `ready_manual` | + ack + explicit pull | "manual-pull integration (community)" |
| 3 | `checkpoint_receive` | `ready_checkpoint` | + native lifecycle checkpoint + `mark_injected` | "checkpoint integration (community)" |
| 4 | `live_receive` | `ready_live` | + structural between-turn push + deadline-safe ack | "live integration (community)" |
| 5 | `reference` | `ready_live` + full degraded/reconnect | tier 4 + reaper/redeliver/takeover exercised by a conformance suite | "reference adapter" |

**Honesty constraints (load-bearing):** Tier is **broker-derived and capped by handshake
evidence**, never self-declared. The only runtime-validated adapter today is **Claude
Code at Tier 3 / `ready_checkpoint` on Bedrock**; `ready_live` (Tier 4/5) is **not
demonstrable on Bedrock** — theoretical until a non-Bedrock transport is tested. Tier 5
"reference" is reserved for an as-yet-unbuilt conformance suite — do not claim it for
anything yet. `(community)` is mandatory on Tiers 1–4 (non-affiliation).

---

## 5. Adapter SDK API proposal

```ts
// @xbus/adapter-sdk — the ONLY surface an adapter touches. A typed facade over the
// EXISTING IpcClient; every method maps 1:1 to an existing FrameType (no new wire verb).
export interface XBusAdapter {
  readonly manifest: AdapterManifest;                                   // static, side-effect-free
  detect(env: RuntimeEnv): DetectResult;                                // cheap probe; NEVER process.exit
  capabilities(): CapabilityDescriptor;                                 // → hello.capabilities[] + role
  resolveIdentity(env: RuntimeEnv): Promise<AdapterIdentity>;           // replaces CLAUDE_CODE_SESSION_ID; typed IdentityError
  register(facade: BrokerFacade, id: AdapterIdentity): Promise<RegisteredSession>;
  receive(facade: BrokerFacade, ctx: ReceiveContext): Promise<ReceiveResult>; // fenced/neutralized presentation
  acknowledge(facade: BrokerFacade, a: AckCommand): Promise<AckResult>;
  reply(facade: BrokerFacade, r: ReplyCommand): Promise<ReplyResult>;
  health(facade: BrokerFacade): Promise<AdapterHealth>;                 // content-free; drives signal_readiness
  shutdown(reason: ShutdownReason): Promise<void>;                      // idempotent, never throws
}

export interface AdapterManifest {
  id: string; displayName: string;
  vendorAffiliation: 'none';                                            // HARD: always 'none'
  receiveModes: ReceiveMode[];                                          // ['hook_checkpoint'] today; additions gated
  protocolCompat: { protocol: 1; minProtocol: 1; schema: 5; stp: 1 };   // MUST equal xbus-p1-stp1-s5 (asserted by C2)
}
```

`BrokerFacade` wraps `IpcClient` so an adapter never imports `src/broker/*` or
`src/database/*`. `BrokerFacade.pullCheckpoint` (the privileged hook pull) is **bound to
the authenticated connection**, not a caller-supplied `sessionId` — preserving the
guard `tests/security/privileged-frames.test.ts` enforces.

**SDK test kit:** `FakeBroker` (in-proc, speaks real `FrameType` verbs + fault
injection), `FakeRuntime` (scripted `RuntimeEnv`; captures presentation instead of
injecting), `LifecycleSimulator` (detect→…→shutdown incl. restart + Stop-continuation),
conformance vectors (forged fence markers, bidi/zero-width, authority-grab), redaction
helpers (assert body-free/path-free output).

---

## 6. Platform dossier template

The reusable schema, abstracted from the eight researched instances (§13). Every future
runtime is dossiered against this **before** any adapter work.

| Field | Meaning / notes |
|---|---|
| `runtimeId` | the EXACT product, disambiguated (resolve ambiguous names first) |
| `vendor`, `versionEra`, `os` | maintaining org; version line (dossiers go stale — pin at integration time); validated OSes |
| `surfaces[]` | official surfaces: hooks / MCP / CLI / SDK / extension / ACP / app-server |
| `mcpSupport` | native / partial / planned / none |
| `sessionIdentityModel` | the `CLAUDE_CODE_SESSION_ID` analogue (the XBus correlation key); **"synthesized"** if none |
| `injectionMechanism` | hook additionalContext / stop-continuation / MCP pull / file-mailbox / none |
| `structuredIO`, `lifecycleEvents[]` | stream-json / JSON-RPC / none; events mappable to `SessionLifecycle` |
| `authModel`, `termsConstraints` | enterprise gates, sandbox rules, key-handling |
| `adapterClass` | native / mcp / cli-wrapper / ide-bridge / sidecar / file-mailbox / webhook |
| **`platformCeilingTier`** | tier the **surfaces** could support — a design target (detected/designed), **NOT awarded** |
| **`awardedTier`** | tier with **runtime evidence today** — T0/T1 until a real adapter + §15 R1–R4 pass |
| `disambiguationNotes` | what the name could mean + what was chosen (mandatory for ambiguous names) |
| `sourceProvenance`, `confidence` | official-primary vs community-secondary per claim; high/med/low |

**Hard rule:** `platformCeilingTier` and `awardedTier` are **different columns** and must
never be conflated. No runtime is awarded **Tier ≥ 2** without a passing §15 R1–R4
runtime log against it; no **Tier ≥ 4** without a non-Bedrock transport proving
`ready_live`; no **Tier 5** until the conformance suite exists. The broker *caps* by
handshake evidence — a manifest cannot self-promote.

---

## 7. Initial target prioritization

Criteria, in order: (1) integration quality; (2) on-box, provider-agnostic transport (not
Bedrock-blockable like Claude Channels); (3) obtainable test environment; (4) clear
security boundary; (5) community value; (6) runtime liveness (not EOL).

| Rank | Runtime | Class | Ceiling / **Awarded** | Why |
|---|---|---|---|---|
| 0 | **Claude Code** | native | T5 ceiling / **T3 awarded** | the baseline; adapter #1 (behavior-identical). T3 = `ready_checkpoint` proven on Bedrock; T4/5 theoretical here. |
| 1 | **Generic MCP / CLI reference** | mcp / cli-wrapper | T2–T3 | **proves the SDK is not Claude-specific** — comes before any 2nd-party adapter. |
| 2 | **OpenAI Codex** | native | T5 ceiling | strongest 2nd-party: hooks (Stop-continuation = proven checkpoint analogue) + App-Server JSON-RPC live plane + two-way MCP; all on-box (no Bedrock-style block). 18 official sources. |
| 3 | **Cursor** | native | T5 ceiling | `stop`-hook `followup_message` = genuine live re-inject; MCP in IDE + CLI; Claude-hook-contract compatible (`CLAUDE_PROJECT_DIR`, exit-2 deny) ⇒ cheap port. ~T3 on cloud agents. |
| 4 | **Gemini CLI** | native | T4 ceiling | best-in-class hook portability (exports `CLAUDE_PROJECT_DIR` alias). **Risk:** account-tier sunset → Antigravity (2026-06-18); target OSS build + API-key/Vertex auth. |
| 5 | **Kiro** | mcp | T4 ceiling | first-party MCP + ACP + 15 lifecycle hooks + stable per-session UUID; no unsolicited wake of an idle TUI (T4 via MCP-poll/ACP-prompt/hook-inject). |
| 6 | **Cline** | cli-wrapper | T4 ceiling | bimodal: SDK/CLI/hub ⇒ T4 (connectors + `onEvent` + `before_agent_start`); **in-IDE extension ⇒ ~T2 (MCP only)**. Security: connectors auto-approve unless gated. |
| 7 | **Hermes Agent** (Nous Research) | native | T5 ceiling | **CONFIRM TARGET FIRST** (Agent runtime vs Hermes model family). If Agent: native MCP both ways + ACP + `pre_llm_call` + `events_wait`. If model family: generic local-model worker (T1). |
| 8 | **Aider** | file-mailbox | T3 ceiling | no MCP (issue #4506 open), no structured I/O, **no session identity** (synthesize from repo/worktree path). `--watch-files` `AI!`-comment mailbox. Proves the lowest-common-denominator adapter. |
| — | ~~Roo Code~~ | — | **EOL** | **archived read-only 2026-05-15**, discontinued. Do NOT build forward; redirect to Cline / Kilo Code / ZooCode. |

---

## 8. Repository evolution plan

Target `packages/` layout (npm workspaces; one `tsconfig` project-references graph so the
import direction is compiler-enforced):

```
packages/
  core/                @xbus/core                broker/ protocol/ ipc/ database/ identity/ observability/ shared/
  adapter-sdk/         @xbus/adapter-sdk         openSession, BrokerFacade, XBusAdapter, CapabilityDescriptor, fence (from instructions.ts)
  adapter-claude-code/ @xbus/adapter-claude-code channel/* + launcher/xclaude.ts + .claude-plugin + hooks
  cli/                 @xbus/cli                 xbus install/status (core + sdk only; NOT an adapter)
```

**7-step incremental extraction — `vitest run` + `tsc --noEmit` green at every step
(never big-bang):** (0) add workspace + project refs + boundary lint, no file moves;
(1) carve `@xbus/core` (pure relocation); (2) add `@xbus/adapter-sdk` as a facade
re-export, no caller migrated; (3) move the fence out of `instructions.ts` into the SDK
(security tests stay green); (4) migrate `mcp-server.ts` + `checkpoint-hook.ts` to
`openSession().{verbs}`; (5) introduce `SessionIdentitySource`, route identity through
`ClaudeCodeIdentitySource`, core/SDK lose all `process.env.CLAUDE_*` reads; (6) relocate
`channel/*` + `xclaude.ts` into `@xbus/adapter-claude-code`; (7) add the `hostAgentVersion`
alias over the retained field/column.

> **PR0 pre-req:** classify `src/shared/artifact-contract.ts` (9 `claude` hits) as core
> vs adapter *before* step 1 — mis-placing it would create a `core → adapter` import.

---

## 9. Migration strategy preserving beta.2 users

**Six version axes; three are wire-frozen:**

| Axis | Source | Frozen? | Bump trigger |
|---|---|---|---|
| Product | `XBUS_VERSION` / package.json | no | any release |
| **Core protocol** | `PROTOCOL_VERSION` / `MIN_SUPPORTED_PROTOCOL_VERSION` | **YES** | frame/envelope/FrameType/required-HelloInfo/MATRIX-semantics change |
| **STP** | `STP_VERSION` (`secure-channel.ts`) | **YES** | handshake bytes / suite / KDF / nonce-seq |
| **Schema** | `SCHEMA_VERSION = max(MIGRATIONS)` | **YES** | any table/column change |
| Adapter-SDK | new `ADAPTER_SDK_VERSION` (semver) | no | `XBusAdapter`/`BrokerFacade`/`CapabilityDescriptor`/`SessionLifecycle` shape |
| Per-adapter | new `manifest.adapterVersion` | no | adapter behavior/host-coupling |

The frozen composite is the interop identity: **`compatibilityId = xbus-p1-stp1-s5`**,
which **already exists** in `shared/build-identity.ts` and is already validated
fail-closed in `provenance.json` (this plan does not "introduce" it — it ships today).

**0.2.0-alpha lands the entire universalization payload with ZERO frozen-axis bump** —
it is product (axis 1) + SDK (axis 5) + adapter (axis 6) motion *above the seam*:
the `BrokerFacade` emits only frames beta.2 already accepts; the `CapabilityDescriptor`
rides the existing `capabilities: string[]`; `SessionLifecycle` projects to the
unchanged `Readiness` with the injectable set unchanged; `hostAgentVersion` is an additive
alias; `resolveIdentity` preserves the existing non-zero exit. Changes that *would* force
a bump (new FrameType → p2; renaming the `claude_code_version` column → s6; persisting a
new lifecycle state → s6; STP byte change → stp2; any grant that *widens* authority →
proto) are **explicitly out of scope** for 0.2.x.

**Negotiation already exists and is graceful** (`checkCompatibility`): each side
advertises a protocol range `[min,max]` + a `schemaVersion`; the broker computes overlap
+ a schema verdict and **fails closed** unless `compatible`. A future approved bump
**widens MAX additively, never raises MIN in a minor** — so a p1-only beta.2 peer's
`[1,1]` keeps overlapping `[1,2]`. Mixed builds are classified by the **already-shipping
`classifyMixedBuild`** (six-way: `same_exact_build` / `compatible_mixed_builds` /
`incompatible_protocol|stp|schema` / `missing_provenance`).

**Data-root + schema migration is safe by construction** (`database/migrations.ts`):
transactional per-migration, checksum-verified on startup (mismatch throws), and
**fail-closed on a newer-than-code DB**. A beta.2 → 0.2.0-alpha upgrade is a **pure code
swap** — schema stays s5, so the runner runs **no migration at all**; it only re-verifies
the existing migrations' checksums. Within the s5 band beta.2 ⇄ 0.2.x downgrade is free;
a future s6 build's migration is append-only and run by the broker (the DB owner).

---

## 10. Threat model (consolidated, STRIDE)

**Trust rules (invariants every adapter preserves):** peer is always untrusted (data,
never instruction; grants no human authority/identity/permission); adapters cannot grant
human authority; provider credentials stay with the provider runtime; authority is bound
to the authenticated connection, not the payload; logs are metadata-only/content-free/
path-free; adapter packages are checksum-covered + allowlisted, **not auto-loaded**; the
remote bridge is **off by default** with a separate threat model; same-user malicious
process and cross-user access are **outside the current local boundary** (need separate
OS-level validation).

**Assets:** A1 broker authority/MATRIX, A2 durable store, A3 root secret, A4 untrusted
peer content, A5 session identity, A6 the privileged hook pull. **Trust boundaries:**
TB1 peer↔broker, TB2 adapter↔SDK↔core, TB3 host-process↔adapter (`resolveIdentity`),
TB4 same-user-process↔XBus (explicitly out of boundary).

| # | Threat | STRIDE | Mitigation | Status |
|---|---|---|---|---|
| T1 | Malicious peer agent | E-of-P, Repud. | fence (untrusted, no authority) + fail-closed MATRIX + authority-from-connection | **HAVE** (`instructions.ts`,`components.ts`,`daemon.ts`) |
| T2 | Malicious message body (forged fence, bidi/zw) | Tamper, E-of-P | marker-neutralization + bidi/zw stripping + per-injection nonce END marker | **HAVE** (`instructions.ts`) |
| T3 | Malicious adapter package | Tamper, E-of-P | checksum + allowlist, not auto-loaded; descriptor narrows only | **NEW** (adapter-era) |
| T4 | Compromised IDE host | Spoof, E-of-P | host identity re-verified by broker authz; cannot widen MATRIX/forge connection-bound authority | **PARTIAL** (core re-verify HAVE; framing NEW) |
| T5 | Credential leakage | Info-Disc. | no provider-cred proxying; root secret never logged; metadata-only logs; `claude`/`xbus` denylist | **HAVE** (`root-secret.ts`,`schemas.ts`,`observability/*`) |
| T6 | Command injection (launcher) | E-of-P | arg-array exec, no shell interpolation of peer/identity data | **PARTIAL** (pattern HAVE; per-adapter audit NEW) |
| T7 | Path injection | Tamper | fixed `secretPath` join; no peer-influenced path | **HAVE** (`root-secret.ts`) |
| T8 | Symlink/reparse | Tamper, E-of-P | `assertNotReparse` rejects symlink/junction | **HAVE** (`acl.ts`) |
| T9 | Stale process | Spoof, DoS | connection-drop revokes authority; reaper + epoch; secret rotation forces re-handshake | **HAVE** (`daemon.ts`, reaper) |
| T10 | Session hijacking | Spoof, E-of-P | authority from authenticated connection; sessionId/role/epoch bound into STP transcript | **HAVE** (`daemon.ts`,`secure-channel.ts`) |
| T11 | Capability spoofing | Spoof, E-of-P | grants advisory + narrow-only; `assertAllowed` sole authority, fail-closed | **HAVE (core) + NEW (descriptor)** |
| T12 | Replay / reorder | Tamper, Repud. | per-direction monotonic seq (`open()` rejects `seq≠recvSeq`) + IV-counter + GCM tag | **HAVE** (`secure-channel.ts`) |
| T13 | Cross-user access | E-of-P, Info-Disc. | data dir + secret + pipe restricted to user (+SYSTEM) + reparse guard | **HAVE (file layer)**; full transport posture NEEDS OS-level validation |
| T14 | Remote-bridge exposure | E-of-P, Info-Disc. | bridge off by default; local-transport-only assumption | **NEW + DEFERRED** (separate model required) |
| T15 | Dependency compromise | Tamper | pinned `node:crypto` only; lockfile; same checksum/allowlist regime as T3 | **PARTIAL** (crypto-pinning HAVE; attestation NEW) |

**Coverage:** 8 fully HAVE (+T13 file layer); 4 PARTIAL (T4/T6/T11/T15); 2 NEW/DEFERRED
(T3, T14). The hostile-host path (T4) and live anti-loop touch the §15 R1–R4 gate, which
is **unproven beyond Tier 3 `ready_checkpoint` on Bedrock**.

---

## 11. Test strategy

**25-point conformance suite (C1–C25), all mockable, in the currently-empty
`tests/contract/`,** driven by the SDK test kit. Highlights: C1/C2 manifest +
`protocolCompat === {1,1,5,1}` guard; C4/C5 detect never throws/never does broker I/O;
C6/C7 role valid + **every grant permitted by MATRIX (no widening)**; C9/C10/C11 typed
`IdentityError`, stable identity, **no peer-granted identity**; C14/C15 receive passes the
fence (markers neutralized, bidi/zw stripped, host-nonce END marker); C16/C17 no spurious
Stop-continuation (anti-loop); C18/C19 correlated ack/reply, no false success; C20 peer
authority-grab does not alter behavior; C21 content-free/path-free output; C22/C23
degrade silently / reconnect on restart; C24 idempotent shutdown; C25 refuse register on
non-`compatible` verdict.

**§15 real-runtime minimum (R1–R4) — the smallest set that CANNOT be honestly mocked and
is explicitly UNPROVEN until a live host boot:** R1 boot + register under the real host
(`register_session_ack` observed); R2 `resolveIdentity` reads the host's real session id;
R3 receive injects `additionalContext` at a real lifecycle checkpoint (fence intact);
R4 bounded Stop-continuation yields exactly one extra turn then halts. This mirrors the
known boot-only failure class (Polly `MaxRetryAttempts=0` — passed unit tests, crashed at
real container boot). Conformance gates *correctness*; R1–R4 gate *reality*. Every second
adapter re-runs R1–R4 against its real host before it ships.

---

## 12. The first three PRs

> **PR0 (pre-req read):** classify `src/shared/artifact-contract.ts` (9 `claude` hits) as core vs adapter — mis-placing it creates a `core → adapter` import.

| PR | Scope | Acceptance gate |
|---|---|---|
| **PR1** — extract `@xbus/adapter-sdk` facade | workspace + project refs + boundary lint; `@xbus/core` (pure relocation) + `@xbus/adapter-sdk` as a facade re-export over the existing `IpcClient`/`doHello`. No caller migrated. | all tests green; `tsc` clean; **zero wire change**; boundary lint passes (core imports no adapter/SDK). |
| **PR2** — conformance suite + **tier-cap** | fill `tests/contract/` with C1–C25 + the SDK test kit. **C2 asserts `protocolCompat === {1,1,5,1}`**; implement the **broker-side tier-cap** (C7 + a tier function) so a manifest cannot self-promote. | all 25 pass; C2 fails CI on any version-axis drift; security vectors pass C14/C15/C20; tier-cap rejects an over-declared manifest. |
| **PR3** — refactor `channel/*` → `ClaudeCodeAdapter` | move `channel/*` + `xclaude.ts` behind the contract by composition; promote the fence into the SDK; route identity via `ClaudeCodeIdentitySource` (typed `IdentityError`, launcher keeps non-zero exit). | `e2e/mcp-tools` + `integration/hook-mcp-coordination` + all `tests/security/*` green; `xbus install` + `--plugin-dir` e2e green; **§15 R1–R4 re-run on a real Claude Code boot** before ship. |

After PR3: the generic MCP/CLI reference adapter (proves vendor-neutrality), then Codex.

---

## 13. Twelve-month milestone map

Every milestone preserves `xbus-p1-stp1-s5` unless an explicitly-approved bump (M7+).

| Months | Milestone | Release | Tier reached (with **evidence**) | Exit criteria |
|---|---|---|---|---|
| M0–1 | SDK seam + conformance + tier-cap (PR1–2) | `0.2.0-alpha.1` | Claude Code **awarded T3** (unchanged) | all tests green; zero wire change; C2 + tier-cap live |
| M2–3 | workspace + `ClaudeCodeAdapter` (PR3) + generic reference adapter | `0.2.0-alpha` | reference adapter completes ack/reply on FakeBroker; **Claude unchanged** | core has zero adapter import; R1–R4 re-pass on real Claude Code |
| M4–6 | 2nd real adapter (Codex) + `ready_manual` proof via a real event-less CLI | `0.2.0-beta` | **≥1 2nd-party awarded T2/T3** by a real R1–R4 log; `ready_manual` drain proven | ≥2 distinct runtimes exchange messages; negotiation proven; no silent downgrade |
| M7–9 | R1–R4 on a **non-Bedrock** runtime → first `ready_live`/T4 evidence; build the Tier-5 "reference" suite | `0.3.0` (+ macOS/Linux packaged install) | first **T4 awarded** off-Bedrock; a **reference (T5)** candidate measurable | live receive proven on a real transport; 3-OS install/exchange/restart/uninstall pass |
| M10–12 | community adapter template + registry + signed artifacts + verified `xbus update`; 3rd/4th adapter | `0.4.0` | community-tier onboarding; multiple T3–T4 adapters | external contributor builds an adapter w/o core changes; matrix auto-generated; downloaded artifact matches provenance |
| (beyond) | protocol-stability + migration maturity + independent security review | **`1.0.0`** | — | **only** when ≥3 platforms deeply validated, 3 OS validated, install/update proven, security review done, matrix machine-generated — **do not rush to 1.0** |

---

## 14. Non-goals (consolidated)

1. No big-bang restructure — extraction is incremental, test-green at every step.
2. No protocol/STP/schema bump in the beta.2 line — `xbus-p1-stp1-s5` is held; any bump is a separate, explicitly-approved versioned change.
3. No provider-credential proxying — XBus is not a model gateway, auth proxy, or subscription reseller.
4. No peer-granted authority — no peer message grants human authority, permission change, identity, or `ready_live` promotion.
5. Not a model-serving framework — local-model support is a generic worker adapter; model hosting stays outside the core.
6. No persisting `busy`/`paused`/`dnd` as schema columns this phase (would force a schema bump).
7. No removing the `claude` reserved-metadata-prefix denylist (it is a security control; generalized to "reserved prefixes", kept).
8. No renaming the in-core `claudeCodeVersion` field / `claude_code_version` column (renaming forces a bump; additive `hostAgentVersion` alias instead).
9. No Tier 5 "reference" label until the conformance suite exists; no Tier ≥ 2 award for any runtime without a passing real-runtime R1–R4 log.
10. No remote/network bridge enabled by default (separate product + threat-model milestone).
11. No UI automation as a supported path (research-only, where no official surface exists).
12. No Hermes adapter until the requester confirms *Hermes Agent runtime* vs the *Hermes model family*.
13. No touching the immutable public baseline `v0.1.0-beta.2` / `69b191f`, the public scanner, or the external gitignored denylist; never use the corporate GitHub account.

---

## Ground-truth corrections (adversarial pass vs. source)

The adversarial verification pass was valuable (it caught real overclaiming and the
beta.2-compat posture), but three of its assertions **contradict the live source at
`69b191f`**; the source wins, and this plan uses the verified facts:

1. **`Operation` enum has 12 members, not 10.** The capability section claimed
   `get_metrics` + `dead_letter` were absent; `identity/components.ts` shows all **12**
   (`register, send, pull_hook_checkpoint, mark_injected, ack, reply, list_inbox,
   list_sessions, get_metrics, dead_letter, change_alias, shutdown`). The descriptor maps
   over all 12.
2. **`classifyMixedBuild` exists.** The migration section claimed it was a phantom; it is
   real at `shared/build-identity.ts:75` (used in `cli/main.ts:203`) and already returns
   the six-way verdict including `incompatible_stp`. The negotiation story uses it as-is.
3. **`compatibilityId` already exists.** It is not a "new sibling to introduce" — it is
   the shipping `compatibilityId()` (`build-identity.ts:51`), already in `provenance.json`
   and validated fail-closed. This makes the core *more* multi-axis-ready than the design
   assumed.

**One scope note on the verification:** a "baseline ambiguity" finding from the review
pass arose because the reviewers inspected a development checkout rather than this public
repository. It is a verification-scope artifact, not a real discrepancy: the **public
frozen baseline at the released tag was verified directly** (the annotated tag and the
published branch both resolve to the same commit, working tree clean) — it is intact and
untouched.

---

## Program reporting (§40)

- **Branch:** `docs/universal-adapter-architecture` (documentation only; opened publicly for community feedback).
- **Baseline:** the immutable public release tag `v0.1.0-beta.2` is **untouched**; this documentation lands additively on top of it on `main`.
- **Changed files:** this document + the architecture/security/adapters docs + `compatibility/platforms.json`.
- **Architectural decisions:** adapter SDK over the existing `IpcClient`; versioned
  capability descriptor riding the existing `capabilities[]`; `SessionLifecycle` superset
  projecting to `Readiness`; six version axes over three frozen wire axes; broker-side
  tier-cap as the keystone honesty control.
- **Real runtimes tested:** none this turn (planning stage). Dossiers researched against
  official docs for 8 runtimes.
- **Capabilities proven:** Claude Code @ **Tier 3 / `ready_checkpoint` on Bedrock** (pre-existing).
- **Capabilities unavailable / theoretical:** `ready_live` (Tier 4/5) on Bedrock;
  `ready_manual` (new, unproven); §15 R1–R4 for every adapter (require a live host boot).
- **Security findings:** the §10 model shows 11/15 threats already mitigated in core; the
  4 new/partial areas are scoped. The keystone risk is **un-capped tier self-promotion** —
  addressed by the PR2 broker-side cap.
- **Platform limitations:** Roo Code EOL; Gemini-CLI tier sunset → Antigravity; Aider has
  no session identity / no MCP; Hermes target needs confirmation.
- **Public claims changed:** none (no publication this turn).
- **Next decision:** confirm whether to (a) keep this as a planning doc, (b) open a PR for
  it on `Kumaraman110/XBus`, or (c) begin PR1 (SDK facade extraction). Also: confirm the
  Hermes target before it enters the cohort.

### Result classification

| Item | State |
|---|---|
| Universalization architecture plan (this doc) | **DESIGN_COMPLETE** |
| Adapter SDK / capability model / lifecycle / threat model / migration | **DESIGN_COMPLETE** (not implemented) |
| Claude Code integration | **REAL_RUNTIME_VALIDATED** at Tier 3 / `ready_checkpoint` (Bedrock) — pre-existing |
| All other runtimes (Codex, Cursor, Kiro, Gemini, Aider, Cline, Hermes) | **DESIGN_COMPLETE** dossier; **awardedTier = T0/T1** until a real adapter + R1–R4 |
| `ready_live` / Tier 4–5 on this environment | **BLOCKED_BY_PLATFORM** (Bedrock has no between-turn push) |
| Hermes adapter | **BLOCKED** pending requester confirmation of the exact runtime |
