# ADR 0035 — beta.10 WS1 ownership consolidation + epoch fencing + WS4 adapter boundary

**Status:** Accepted (beta.10, local-only; not yet merged/published). Builds on ADR 0033 (split
identity teardown) and ADR 0034 (s11 data model). Records the WS1 R2/R3/R4 decisions and the WS4
provider-adapter boundary.

## WS1 R2 — one authoritative name-ownership release primitive
**Decision.** All `name_ownership` RELEASE flows through ONE private primitive
`releaseNameOwnership(where, markSuperseded, now)` (src/broker/store.ts). Callers: the
predecessor-supersede release inside `setNameOwnershipActive` (markSuperseded=true) and the
standalone `setNameOwnershipReleased` (markSuperseded=false). Only the WHERE predicate + whether
`superseded_at` is stamped vary per caller; the released-column treatment (`name_state='released'`,
`normalized_name=NULL`, `owner_secret_hash` PRESERVED) is byte-identical everywhere, so a future
change to "released" semantics cannot silently skip a caller.
**Why.** The risk register found 3 divergent inline releases; R1 removed the reaper's release
(expiry = dormancy now keeps the handle), leaving 2 in store.ts — consolidated here into 1.
**Proof.** ownership-primitive.test.ts (no half-released row from any path). Adversarial+Reliability
review of R2/R3/R4 = Package B (pending at time of writing).
**Authority-primitive roster (R2 invariant "one path mutates ownership").** The sanctioned writers
of the dedicated authority tables (`name_ownership`, `physical_session_map`, `session_epochs`,
`fencing_counter`) are, in full: `setNameOwnershipActive` (award), `releaseNameOwnership` (release),
`register()` (reclaim redirect / stale-edge self-heal / epoch lifecycle via `nextEpochToken`),
`reapExpiredSessions` (expiry-GC = dormancy), and the two operator-console primitives
`operatorRenameAlias` (award mirror; operator holds no SessionAuthority so cannot call
`renameSession`) + `operatorRemoveRecord` (destruction GC). Migrations are DDL/backfill only. This
roster is now STATICALLY ENFORCED by ownership-authority-guard.test.ts (table-scoped): a raw-SQL
write to any of the four tables from a non-allow-listed file fails CI, so the invariant cannot
silently erode. A 5-agent bypass audit (wf_50494ea9, 70 sites) found ZERO production bypasses.
**Hygiene.** The audit flagged private `nextFencingToken()` as zero-caller dead code (a latent
footgun that could bump the shared fence outside a lifecycle transition); it was removed. Only
`nextEpochToken` bumps `fencing_counter`, guarded by the same static test.

## WS1 R3 — hash-chained ledger completeness for credential birth
**Decision.** A FIRST protected name award (a fresh owner secret minted in `setNameOwnershipActive`)
writes a hash-chained `name.awarded` ledger event. Credential birth is an identity-authority
transition and must be tamper-evident, closing the gap where award was only best-effort audited.
The secret plaintext NEVER enters the ledger payload (D7 invariant; test asserts). Combined with
ADR 0032 (reclaim/rename/expired-resume already ledgered), every authority mutation is now chained.

## WS1 R4 — epoch fencing on every session-authority mutation
**Decision.** A shared store-side `assertCurrentEpoch(auth)` (mirrors DeliveryOps') rejects a
stale-epoch caller (`auth.epoch !== sessions.active_epoch` → EPOCH_MISMATCH). Applied to
`registerAlias` (previously unfenced — a routing-hijack gap), joining `renameSession` +
`signalReadiness`. Operator-authority methods (operatorSetControl/Pinned/Archived/RenameAlias/
RemoveRecord/Redeliver) are `local-operator`-scoped + bearer-gated — they carry no session epoch,
so epoch-fencing correctly applies to SESSION-authority paths only.
**Proof.** epoch-fencing.test.ts (stale registerAlias rejected + alias not created + current epoch
still works); ownership-atomicity.test.ts (transaction-failure rollback for ledger/map/ownership
writes across R1/R2/R3 — no partial state, retryable).

## WS4 — provider adapter boundary (SessionIdentitySource)
**Decision.** Host-agent lifecycle (session-id discovery, transcripts root, wake capability, host
vocabulary) lives behind `SessionIdentitySource` (src/adapter/session-identity.ts). `ClaudeCodeAdapter`
reads `CLAUDE_CODE_SESSION_ID` + `~/.claude/projects` (injectable env+homedir; never invents an id).
`FakeAdapter` gives deterministic host-neutral values. The AgenTel core (identity, messaging,
persistence, conversations, Collections, work items) is provider-neutral WITHIN `src/broker` (the
one documented in-broker exception is `session-import.ts`, below); host env is read at the channel
EDGE, not in broker-core.
**Boundary enforcement (with HONEST, stated limits).** adapter-boundary-guard.test.ts statically
fails if any `src/broker` file reads a `CLAUDE_*` env var (dotted, `process.env['CLAUDE_X']` bracket,
OR `const { CLAUDE_X } = process.env` destructure) or couples to a `.claude` on-disk path (a single
`'.../.claude/...'` literal OR a segmented `path.join(..., '.claude', ...)` join) in non-comment
code. The env + path regexes were HARDENED after a Package-B adversarial finding proved the original
pair evadable (old path regex needed `.claude`+slash in ONE literal, so a segmented join slipped
past; old env regex matched only dotted access) — verified to bite on both shapes. **Stated limits
(not silently relied on):** (1) the guard scans `src/broker` ONLY — the host EDGE (`src/channel/*`
hooks + MCP `server` + `rewaker`) legitimately reads `process.env.CLAUDE_CODE_SESSION_ID` and is
intentionally out of scope (that is where host env is *supposed* to be read); (2) it is a
text-pattern tripwire for the COMMON coupling shapes, not a proof of neutrality — a sufficiently
obfuscated read (aliased env object, computed property name) could still evade it. One allow-listed
in-`src/broker` exception: `session-import.ts` (dormant-session discovery) resolves the transcripts
root via the injectable `XBUS_CLAUDE_PROJECTS_DIR` override + a segmented `~/.claude/projects` join —
this IS a real broker-core coupling to Claude's on-disk layout; it is allow-listed and stated here
rather than hidden, and is the intended next thing to route through `ClaudeCodeAdapter.transcriptsRoot()`.
**Adapter is a tested SEAM, not yet WIRED (honest status — "cannot silently erode" was overstated).**
At this HEAD `SessionIdentitySource`/`ClaudeCodeAdapter`/`FakeAdapter` are constructed ONLY in tests;
NO production path imports `session-identity.ts`. Production identity discovery still happens at the
channel edge (`session-start-hook`, `checkpoint-hook`, `server`, `rewaker` each read
`process.env.CLAUDE_CODE_SESSION_ID` directly and hand the resolved id inward as a plain param, so
`mcp-server`/broker-core stay clean). So WS4 delivers (a) a tested seam + conformance proof that the
core CAN run host-neutrally, and (b) a regression tripwire against NEW broker-core Claude coupling —
NOT a claim that the live path already flows through the adapter. Wiring the channel edge to call
`adapter.resolveSessionId()` (which would let the guard extend to `src/channel`) is deferred
follow-up work.
**Conformance.** adapter-conformance.test.ts proves identity/delivery/reclaim/restart/reply work
through the FakeAdapter with NO Claude-specific identifier, plus adapter failure/disconnect/reconnect.
**Non-goal.** NO Codex production support is claimed — this is the seam that makes a future host
trivial + testable. Neutralizing the `claudeCodeVersion` WIRE field (RegisterPayload) is a
wire-compat change and is explicitly OUT of beta.10 scope (would be a separate authorized change).

## Compatibility
WS1 R2/R3/R4 + WS4 are s10-neutral (no schema/wire change beyond the separately-authorized s11 data
model in ADR 0034). No inbox re-key. Local-only; nothing pushed.
