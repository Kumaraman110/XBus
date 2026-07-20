# ADR 0030 — recycled-PID liveness proof (beta.9.1 / beta.10 Stage 0 Part B)

**Status:** Accepted (beta.9.1). Originally authored as part of the reviewed beta.10 Stage-0 work,
which bundled this recycled-PID fix (Part B) with the ADR-0027 D7 ledger debt (Part A). For the
beta.9.1 point-release the two are decomposed into independently-revertible commits: this ADR covers
the recycled-PID liveness proof; the D7 ledger atomicity is documented in ADR 0032. The primitive is
byte-identical to the reviewed Stage-0 baseline (the exact Stage-0 source is recorded in git history
and the beta.9.1 decomposition equivalence proof).

**Context:** A prerequisite for the durable-role work (Stage 1) and adoption/transfer (Stage 3),
independently valuable and shippable with no schema/protocol change.

## Problem (ADR-0007 violation)
A hard-killed broker leaves its state file behind; the OS can recycle its PID to an unrelated
same-user process. `pidIsAlive` + owner-hash then wrongly conclude "our broker is alive", which
can SIGTERM the innocent process (stop path) or wedge auto-restart (singleton path).

## Fix — three-verdict liveness proof
`classifyLiveness(pid, recordedCreationMs, endpoint, deps)` returns:
- `proven_live_broker` — pid alive AND (OS creation-time matches the recorded marker within
  tolerance, OR STP handshake completes).
- `proven_dead_or_recycled` — pid dead, OR pid alive but OS creation-time positively MISMATCHES the
  marker (proof-of-recycle).
- `inconclusive` — neither arm can conclude (old state file with no marker AND no/failed handshake).

**Opposite fail-closed per caller** (the correctness core):
- `classifyShutdown` (KILL): `proven_live`→`ipc`; `proven_dead_or_recycled`→`none`(stale);
  **`inconclusive`→`refuse` (never signal — ADR-0007).**
- `checkSingleton` (ACQUIRE): `proven_live`→`contended`(starting); `proven_dead_or_recycled`→
  `stale_cleared`; **`inconclusive`→`contended` (never spawn a duplicate; defer to the OS bind
  arbiter).**

**Round-trip integrity:** `host.ts` records `processCreatedAt` via the SAME `osProcessCreationTimeMs`
reader the proof calls on the way back in — Windows emits UTC .NET ticks (culture/timezone-invariant)
→ epoch ms; POSIX uses `ps -o lstart`. Bounded (2s) + fail-safe (null, never throw, never a false
positive) on every OS read. A real broker compares equal within tolerance and is never mislabeled
recycled (validated S0-B11).

**Both callers, both paths:** `cmdStop` (`main.ts`) and `stopOwnedBrokerForUpgrade` (`install.ts`)
ride the hardened `classifyShutdown`; `checkSingleton` (`singleton.ts`) hardens the acquire path.

### Known fail-safe tradeoff (documented)
On an OLD state file (no `processCreatedAt`) with no handshake arm wired, a real broker falls to
`inconclusive` → cannot be gracefully IPC-stopped via the new path until it restarts and re-writes a
creation-time marker. This is fail-SAFE (never kills the wrong process, never wedges destructively).
The creation-time arm is sufficient for the recycled-PID class; wiring the production STP-handshake
arm (to restore graceful-stop for pre-upgrade brokers) is a candidate follow-up.

## Compatibility / migration
NO schema change (`processCreatedAt` is an additive/optional state-file field older readers ignore).
NO `SCHEMA_VERSION`/`compatibilityId` bump, NO protocol change. Rollback = revert this commit.
Behavioral-only. This commit is independently revertible from the D7 ledger change (ADR 0032).
