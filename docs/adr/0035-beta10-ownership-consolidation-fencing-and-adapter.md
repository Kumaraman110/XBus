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
persistence, conversations, Collections, work items) is provider-NEUTRAL.
**Boundary enforcement.** adapter-boundary-guard.test.ts statically fails if any `src/broker` file
reads `process.env.CLAUDE_*` or hard-codes a `.claude` path in non-comment code. One documented
allow-listed exception: `session-import.ts` (dormant-session discovery) via the injectable
`XBUS_CLAUDE_PROJECTS_DIR` override — the same seam `ClaudeCodeAdapter.transcriptsRoot()` uses.
**Conformance.** adapter-conformance.test.ts proves identity/delivery/reclaim/restart/reply work
through the FakeAdapter with NO Claude-specific identifier, plus adapter failure/disconnect/reconnect.
**Non-goal.** NO Codex production support is claimed — this is the seam that makes a future host
trivial + testable. Neutralizing the `claudeCodeVersion` WIRE field (RegisterPayload) is a
wire-compat change and is explicitly OUT of beta.10 scope (would be a separate authorized change).

## Compatibility
WS1 R2/R3/R4 + WS4 are s10-neutral (no schema/wire change beyond the separately-authorized s11 data
model in ADR 0034). No inbox re-key. Local-only; nothing pushed.
