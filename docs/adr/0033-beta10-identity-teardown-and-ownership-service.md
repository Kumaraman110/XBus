# ADR 0033 — beta.10 WS1: identity teardown semantics + single ownership-transition service

**Status:** Proposed (beta.10, local-only). Implements the user-authorized split-teardown decision
for the Rank-1 identity-kernel risk (stale `physical_session_map` → secret-less resurrection /
inbox adoption). RED-first matrix: `tests/integration/identity-map-lifecycle.test.ts` (10 cases,
9 RED / 1 already-green at the pre-fix baseline).

**Schema:** s10 (no wire bump). Dormancy is represented on the EXISTING `sessions.expired_at` axis;
the fix is that expiry must STOP releasing `name_ownership` (keep the handle held-but-dormant),
while remove DELETES it. The 10-case matrix arbitrates; a pre-authorized "smallest s11 explicit
lifecycle state" is the fallback only if a case cannot go green on s10.

## Problem (verified @ 6195020)
`physical_session_map` has one writer (register reclaim branch) and NO GC. `operatorRemoveRecord`
deletes 7 tables but leaves `physical_session_map` + `name_ownership` dangling. Register reads the
map and redirects onto the canonical id BEFORE any secret check. So after remove OR 15-day expiry,
a secret-less register under a previously-mapped physical id is redirected onto the torn-down
identity and adopts its inbox — a credential-bypass + stale-map resurrection.

## Decision — split teardown

### REMOVE (`operatorRemoveRecord`) = explicit destruction (atomic)
1. DELETE every `physical_session_map` edge referencing the target as physical_session_id,
   canonical_session_id, OR logical_identity_id.
2. Release + DELETE the target's `name_ownership` row (handle returns to the pool).
3. Invalidate the ownership secret (the row is gone → the old secret matches nothing;
   `resolveReclaim` finds no active/pending owner → no reclaim).
4. Preserve transcript, messages, ledger (append-only history by value, not FK).
5. Transition every unfinished delivery (queued/retry_wait/transport_written/accepted) to an
   EXPLICIT terminal `failure_category='recipient_removed'` — no adoptable/silent orphan.
6. All in the existing `operatorRemoveRecord` transaction; ledgered `OPERATOR_SESSION_RECORD_REMOVED`.

Post-remove: same physical id → fresh identity; old secret → no authority; freed handle →
normally claimable; A → unreclaimable through any stale mapping.

### EXPIRY (reaper `reapExpiredSessions`) = dormancy, NOT deletion (atomic)
1. DELETE transient `physical_session_map` rows targeting the expiring logical identity
   (the map is a live-redirect cache; it must not survive dormancy).
2. PRESERVE the logical identity, inbox, `owner_secret_hash`, conversation history, and the
   protected handle. **Do NOT set `name_ownership.name_state='released'` and do NOT clear
   `normalized_name`** (the beta.9 bug — that frees the handle for takeover). The identity stays
   the active `name_ownership` owner but is DORMANT via `sessions.expired_at` (existing axis).
3. Require the valid owner secret to reactivate (the existing reclaim path already enforces this).
4. Secret-less / wrong-secret register under the old physical id → fresh/pending, never redirected.
5. Valid secret → reclaim A + its preserved inbox under a fresh epoch (existing `isExpiredResume`
   fresh-lifecycle path, now finding the still-owned dormant `name_ownership`).
6. Accepted-reply obligations remain recoverable under the beta.9.1 reply-authority rules.

Consequence: expiry keeps the handle HELD (dormant), so `reapStalePendingNames`/alias-release still
free the automatic alias for routing hygiene, but the durable USER handle stays owned. `session_name_state`
retire semantics for the sessions projection are reconciled so the name_ownership row (authority)
stays active-dormant while the sessions row carries `expired_at` (dormancy flag).

### REGISTER/READ defense-in-depth (independent of cleanup — protects corrupt/upgraded DBs)
Follow a `physical_session_map` edge ONLY when the canonical target (a) EXISTS as a sessions row
AND (b) is redirect-eligible (not a dormant/removed identity being resolved secret-lessly). If the
edge is dangling (missing target) or ineligible, transactionally PURGE it and continue through
normal registration. Require secret verification before dormant-identity reactivation (a secret-less
map-follow onto a dormant identity is refused).

## Single ownership-transition service (R2/R3 consolidation)
Introduce ONE primitive pair that owns every `name_ownership` + `physical_session_map` mutation and
appends the hash-chained ledger event for each award/release (closing R3 — the reaper currently has
no `ledger()`):
- `awardNameOwnership(logicalId, canonicalSessionId, norm, now)` — the current `setNameOwnershipActive`
  behavior, ledgered.
- `releaseNameOwnership(logicalId | currentSessionId, cause, now)` — ONE release with a `cause`
  (`superseded` | `pending` | `expired-dormant` | `removed`); `expired-dormant` does NOT clear the
  handle, `removed` DELETEs the row, `superseded`/`pending` behave as today. Ledgered.
- `purgeSessionMap({ physical?, canonical?, logical? }, now)` — the single map-GC, called by remove,
  expiry, and the register self-heal path.
markPending, the predecessor-release inside award, the reaper, and operatorRemoveRecord all route
through these — no divergent inline SQL (closes R2).

## Non-goals
No new tables, no wire change, no general tombstone subsystem, no inbox re-key (ADR-0027 canonical-
session redirection preserved). Adoption/transfer (Stage-3) remains out of scope.
