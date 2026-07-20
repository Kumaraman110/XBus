# ADR 0032 — durable-identity ledger transitions are abort-atomic (ADR-0027 D7)

**Status:** Accepted (beta.9.1).
**Relationship:** Implements the ADR-0027 D7 requirement. Originally authored as part of the
reviewed beta.10 Stage-0 work (Part A), decomposed for beta.9.1 into its own independently-revertible
commit, separate from the recycled-PID liveness proof (ADR 0030). The `audit()→ledger()` production
change is byte-identical to the reviewed Stage-0 baseline (the exact Stage-0 source is recorded in
git history and the beta.9.1 decomposition equivalence proof); this ADR adds the explicit
failure-path proof that beta.9 lacked.

**Context.** The intended atomicity — an identity-authority transition and its hash-chained audit
record commit or roll back together — was the DESIGN in the reviewed Stage-0 work: the events
already route through `ledger()` inside the enclosing `register()`/`renameSession()` transaction,
and `ledgerAppend` throws `AUDIT_PERSISTENCE_FAILED` on any ledger-specific failure, which rolls the
transaction back. What beta.9 lacked was (a) the D7 implementation itself on the beta.9 line and
(b) an EXPLICIT fault-injection proof of the failure path. This commit supplies both.

## Decision
Route the committed identity-AUTHORITY transitions through the hash-chained `ledger()` (was
best-effort `audit()`), in the SAME transaction as the state mutation:

| Event string | When | actor | subject | payload |
|---|---|---|---|---|
| `identity.reclaimed` | a cross-id reclaim redirects a successor onto a canonical identity | canonical (durable) session id | `{sessionId: canonical}` | `{physicalSessionId}` |
| `session.expired_resumed` | an expired session resumes under its own id (fresh lifecycle) | the resuming session id | `{sessionId}` | `{epoch}` |
| `session.rename` | a session claims/changes its name | the renaming session id | `{sessionId}` | `{name}` (display name) |
| `session.expired_resumed_via_rename` | expired-resume during a rename | the renaming session id | `{sessionId}` | `{name}` |

(These implemented strings supersede the ADR-0027 D7 draft names `name.superseded`/`identity.reclaimed`.
`verifyLedger` is event-name-agnostic; no `src/` consumer references the old UPPER_SNAKE names.)

### Deliberately NOT ledgered (stay on best-effort `audit()`)
- `SESSION_ALREADY_ACTIVE` — a rejection that THROWS and rolls back the register txn; a ledger
  append inside a rolled-back txn leaves no row. Rejected-takeover attempts are therefore NOT
  durably auditable in this release (a documented limitation; the `audit_events` row also rolls back).
- `COMPONENT_REGISTERED` — a routine component join (hottest path: every hook + MCP join + reconnect),
  not an identity-authority transition; chaining it would multiply ledger-abort exposure for no
  authority benefit.

### Failure semantics (the invariant this commit proves)
`ledger()` → `ledgerAppend` throws `AUDIT_PERSISTENCE_FAILED` and ABORTS the whole op, vs `audit()`
which is best-effort. A full/locked/corrupt ledger disk now aborts a `register`(reclaim)/`rename`
that previously (on the best-effort path) would have committed the state mutation while silently
dropping its audit. This is the correct tamper-evidence tradeoff: **state never exists without its
chained audit record.** Append-only — pre-beta.10 reclaims are not retroactively tamper-evident
(no backfill).

## Proof — abort-atomicity fault injection (RED-first)
`tests/integration/d7-ledger-atomicity.test.ts` injects a ledger-write failure (a
`BEFORE INSERT ON ledger_events` trigger that `RAISE(ABORT)`s — a deterministic stand-in for a
full/locked/corrupt ledger disk) and proves, for both RENAME and CROSS-ID RECLAIM:
- the op throws `AUDIT_PERSISTENCE_FAILED`;
- NO partial ownership/state mutation commits (name stays unnamed; no `name_ownership` row; no
  `physical_session_map` takeover; incumbent unchanged);
- NO partial identity event commits (ledger row count unchanged);
- the database remains in its pre-operation state, and a later op with the ledger healthy succeeds
  cleanly (no poison state / stuck lock / broken chain tip).
A GUARD SELF-CHECK proves the injected failure genuinely fires (same op commits+chains WITHOUT the
break, aborts WITHOUT state WITH the break) so the assertions are non-vacuous. Separately verified
out-of-band during review: routing the identity event through best-effort `audit()` instead of the
fatal `ledger()` makes all four tests RED — i.e. the guard catches a non-fatal-ledger regression.
The positive path (events land in the chain, secret never in the ledger) is covered by
`tests/integration/stage0-d7-ledger.test.ts`.

## Compatibility
NO schema change (`ledger_events` exists since v7). NO `SCHEMA_VERSION`/`compatibilityId` bump, NO
protocol change. Behavioral-only; independently revertible from the recycled-PID change (ADR 0030).
A valid revert of this commit removes the ledger-backed identity-event behavior, this ADR, the
positive D7 tests, and the fault-injection proof together — leaving neither production code without
its proof nor tests that intentionally fail against reverted behavior.
