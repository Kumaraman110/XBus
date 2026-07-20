# AgenTel v0.1.0-beta.9.1 — acceptance manifest

Durable-identity correctness hotfix. Compatibility UNCHANGED (schema 10 / `xbus-p1-stp1-s10` /
protocol 1 / XBUS-STP 1). beta.9 is the upgrade source. This manifest maps each required
acceptance item to the coverage that verifies it; the aggregate release gate runs these under an
APPROVED Node runtime in `[22.13, 25)` (the machine PATH node v25 is out-of-floor; use the pinned
runtime / an isolated Node-22 harness).

Reviewed runtime baseline: the four runtime commits (CSPRNG, recycled-PID, reply-pending-orphan,
D7), all three reviewer gates green (exact SHAs recorded in git history + the beta.9.1 decomposition
equivalence proof). This manifest and the version-identity edits are commit 5 (the release
candidate); the candidate's provenance is
generated AFTER commit 5 and reports the commit-5 SHA.

| # | Acceptance item | Verified by |
|---|---|---|
| 1 | beta.9 → beta.9.1 upgrade (schema/compat unchanged, s10) | `tests/unit/version-consistency.test.ts` (s10 pinned) + `tests/unit/migration-v10.test.ts` (head schema 10) + no `migrations.ts` diff between the beta.9 tag and the reviewed runtime baseline |
| 2 | Existing beta.9 owner-secret validity (no invalidation) | `tests/unit/credential-csprng.test.ts` [3b] legacy issued-secret still verifies+reclaims; `hashSecret` unchanged |
| 3 | New CSPRNG secret minting | `tests/unit/credential-csprng.test.ts` [1][2][5][6][7] (length/encoding, no-collision, cryptographic source, reconstruction-insufficient, seam cannot alter production default) |
| 4 | Recycled PID rejection | `tests/unit/liveness-proof.test.ts` (three-verdict truth table) + `tests/integration/broker-shutdown.test.ts` (KILL fail-closed) |
| 5 | Legitimate owned broker recognition | `tests/unit/liveness-proof.test.ts` (proven_live_broker, creation-time round-trip S0-B11) |
| 6 | Stale-owner + crash recovery | `tests/integration/singleton.test.ts` (ACQUIRE stale_cleared / contended) + `broker-shutdown.test.ts` |
| 7 | Accepted reply-pending reclaim | `tests/integration/reply-pending-orphan.test.ts` PATH 1 (successor completes; reviewer live-repro 13/13) |
| 8 | No duplicate body injection | `reply-pending-orphan.test.ts` (bodyPresentations==1; authority row added, body not re-shown) |
| 9 | Old-epoch rejection | `reply-pending-orphan.test.ts` (stale-epoch reply throws; `assertCurrentEpoch` fencing) |
| 10 | Exactly one correlated reply | `reply-pending-orphan.test.ts` (replyCount==1, delivery→completed) |
| 11 | Broker restart continuity | `reply-pending-orphan.test.ts` INVARIANT 6 (obligation survives reopen; reviewer restart-repro) |
| 12 | Explicit unanswered-reply expiry | `reply-pending-orphan.test.ts` PATH 2 (`reply_pending_unanswered_15_days`, not silent dead_letter; 4-outcome distinguishability) |
| 13 | D7 ledger-failure rollback | `tests/integration/d7-ledger-atomicity.test.ts` (fault-injection: abort, no half-state) + `stage0-d7-ledger.test.ts` (positive) |
| 14 | Clean isolated Windows installation | `scripts/clean-machine-accept.mjs` (`npm run accept:clean-machine`) + `tests/integration/bundled-installer-acceptance.test.ts` |
| 15 | Rollback | `tests/integration/beta3-to-beta4-upgrade.test.ts` pattern + revert-per-commit (each of the 4 runtime commits is independently revertible; no schema to un-migrate) |
| 16 | Golden beta.9 isolation | Disposable `AGENTEL_INSTALL_ROOT`/`AGENTEL_DATA_DIR`/`CLAUDE_CONFIG_DIR` in every harness; Reliability confirmed golden manifest mtime unchanged across the pinned-SHA validation |

## Aggregate release-gate sequence (run after commit 5)
1. Version consistency (`version-consistency.test.ts`) — product 0.1.0-beta.9.1, compat s10.
2. Full aggregate gate: build + lint + typecheck + all shards + security tests + `npm audit` +
   clean-machine + identity-reclaim acceptance (`npm run verify:release`).
3. Build twice; prove byte-identical artifacts; record both SHA-256 values (runtime-free + bundled).
4. Verify candidate provenance `sourceCommit` == the exact commit-5 SHA.
5. Push the candidate head non-force; pin Release-Engineer review to that SHA.
6. Open the beta.9.1 PR only after the gate is green.

No tag or publication before post-merge reproducibility + downloaded-artifact acceptance (rebuild
from merged `main`, provenance points to the merged SHA, verify public checksum + install).

## Gate outputs (recorded here + in the release-candidate report; NOT source inputs to commit 5)
- runtime-free ZIP SHA-256: _(recorded at gate time)_
- bundled ZIP SHA-256: _(recorded at gate time)_
- candidate provenance `sourceCommit` / `buildId`: _(the commit-5 SHA, recorded at gate time)_
