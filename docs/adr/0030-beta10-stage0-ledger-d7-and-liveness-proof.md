# ADR 0030 — beta.10 Stage 0: hash-chain identity events (ADR-0027 D7 debt) + recycled-PID liveness proof

**Status:** Accepted (implemented, commit on `feat/beta10-stage0-ledger-d7-and-liveness-proof`).
**Context:** Stage 0 of beta.10 Milestone 1. Two prerequisites for the durable-role work (Stage 1) and the adoption/transfer work (Stage 3), both independently valuable and shippable with no schema/protocol change.

## Part A — ADR-0027 D7 ledger debt

ADR 0027 D7 required the identity-authority transitions to be recorded in the **hash-chained** `ledger_events` in the same transaction as the state mutation. The beta.8/beta.9 implementation emitted them via the best-effort, non-chained `audit()` path — so the most security-sensitive events were the *least* tamper-evident. Stage 0 routes the **committed** identity-authority transitions through `ledger()` inside the existing `register()` / `renameSession()` transactions.

### Emitted ledger event vocabulary (the ACTUAL strings — supersedes the ADR-0027 D7 draft names)
The D7 draft used `name.superseded` / `identity.reclaimed`. The implemented, emitted event-type strings are:

| Event string | When | actor | subject | payload |
|---|---|---|---|---|
| `identity.reclaimed` | a cross-id reclaim redirects a successor onto a canonical identity (store.ts) | canonical (durable) session id | `{sessionId: canonical}` | `{physicalSessionId}` |
| `session.expired_resumed` | an expired session resumes under its own id (fresh lifecycle) | the resuming session id | `{sessionId}` | `{epoch}` |
| `session.rename` | a session claims/changes its name | the renaming session id | `{sessionId}` | `{name}` (display name) |
| `session.expired_resumed_via_rename` | expired-resume that occurs during a rename | the renaming session id | `{sessionId}` | `{name}` |

Future ledger queries / dashboard filters MUST use these strings (not the draft `name.superseded`). `verifyLedger` is event-name-agnostic (it hashes each row by its stored `event_type`), so the rename breaks no consumer; a grep confirmed no `src/` consumer references the old UPPER_SNAKE identity names.

### Deliberately NOT ledgered (stay on best-effort `audit()`)
- `SESSION_ALREADY_ACTIVE` — a rejection that **throws and rolls back** the register txn; a ledger append inside a rolled-back txn leaves no row, so it cannot be durably recorded there. Documented limitation: **rejected-takeover attempts are NOT durably auditable in M1** (the `audit_events` row also rolls back). Out-of-transaction rejection audit would be a future feature.
- `COMPONENT_REGISTERED` — a routine component join (fires on every hook + MCP join and every reconnect — the hottest path), not an identity-authority transition. Chaining it would multiply the ledger-append-abort exposure on the hottest path for no authority benefit; every authority transition is separately ledgered.

### Failure-semantics change (deliberate)
`ledger()` → `ledgerAppend` throws `AUDIT_PERSISTENCE_FAILED` and **aborts the whole op**, vs `audit()` which is best-effort. So a full/locked ledger disk now aborts a `register`(reclaim)/`rename` that previously succeeded silently. This is the correct tamper-evidence tradeoff (state never exists without its chained audit). Proven atomic (no half-state) by Reliability's fault-injection harness (S0-A4). Append-only: pre-beta.10 reclaims are **not** retroactively tamper-evident (no backfill).

## Part B — recycled-PID liveness proof (also the beta.9 hotfix primitive)

**Problem (ADR-0007 violation):** a hard-killed broker leaves its state file behind; the OS can recycle its PID to an unrelated same-user process. `pidIsAlive` + owner-hash then wrongly conclude "our broker is alive", which can SIGTERM the innocent process (stop path) or wedge auto-restart (singleton path).

**Fix:** `classifyLiveness(pid, recordedCreationMs, endpoint, deps)` returns a **three-verdict** result:
- `proven_live_broker` — pid alive AND (OS creation-time matches the recorded marker within tolerance, OR STP handshake completes).
- `proven_dead_or_recycled` — pid dead, OR pid alive but OS creation-time positively MISMATCHES the marker (proof-of-recycle).
- `inconclusive` — neither arm can conclude (old state file with no marker AND no/failed handshake).

**Opposite fail-closed per caller** (the correctness core):
- `classifyShutdown` (KILL): `proven_live`→`ipc`; `proven_dead_or_recycled`→`none`(stale); **`inconclusive`→`refuse` (never signal — ADR-0007).**
- `checkSingleton` (ACQUIRE): `proven_live`→`contended`(starting); `proven_dead_or_recycled`→`stale_cleared`; **`inconclusive`→`contended` (never spawn a duplicate; defer to the OS bind arbiter).**

**Round-trip integrity:** `host.ts` records `processCreatedAt` via the SAME `osProcessCreationTimeMs` reader the proof calls on the way back in — Windows emits UTC .NET ticks (culture/timezone-invariant) → epoch ms; POSIX uses `ps -o lstart`. Bounded (2s) + fail-safe (null, never throw, never a false positive) on every OS read. A real broker compares equal within tolerance and is never mislabeled recycled (validated S0-B11).

**Both callers, both paths:** `cmdStop` (`main.ts`) and `stopOwnedBrokerForUpgrade` (`install.ts`) ride the hardened `classifyShutdown`; `checkSingleton` (`singleton.ts`) hardens the acquire path.

### Known fail-safe tradeoff (documented)
On an OLD state file (no `processCreatedAt`) with no handshake arm wired, a real broker falls to `inconclusive` → cannot be gracefully IPC-stopped via the new path until it restarts and re-writes a creation-time marker. This is fail-SAFE (never kills the wrong process, never wedges destructively). The creation-time arm is sufficient for the recycled-PID class; wiring the production STP-handshake arm (to restore graceful-stop for pre-upgrade brokers) is a candidate follow-up.

## Compatibility / migration
NO schema change (ledger_events exists since v7; `processCreatedAt` is an additive/optional state-file field older readers ignore). NO `SCHEMA_VERSION`/`compatibilityId` bump, NO protocol change. Rollback = revert the branch. Stage 0 is behavioral-only.

## beta.9 intersection
The liveness-proof primitive (`src/broker/liveness-proof.ts`) is authored to be identical to the beta.9 recycled-PID hotfix. Whether it ships as beta.9.1 or only with beta.10 is the Release Engineer's recommendation (beta.9.1 first) pending the user's decision; no beta.10 identity changes are mixed into the hotfix.
