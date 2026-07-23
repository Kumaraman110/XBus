# ADR 0027 — beta.8: Durable logical identity and session-continuity reclaim

**Status:** Accepted (beta.8) — revised after adversarial design review (5 lenses, verdict
`design-needs-revision`; all blockers folded in below).
**Supersedes/extends:** ADR 0003 (identity + receipt authority), ADR 0012 (session names + expiry)
**Migration:** schema 9 → 10 (`xbus-p1-stp1-s10`), additive-only

## Context — the defect

A session's durable identity is, today, the raw `session_id` supplied at register (Claude
Code's session id: the MCP server reads `CLAUDE_CODE_SESSION_ID`, the hook reads the
SessionStart stdin `session_id`). Name, aliases, inbox (`recipient_sequences`,
`deliveries.recipient_session_id`, `messages.recipient_session_id`), threads, and receipts all
hang off that one column (`sessions.session_id` PK, `migrations.ts:35`). The epoch/generation/
fencing machinery (`active_epoch`, `session_epochs.epoch_token_hash`, `superseded_at`,
`component_instances`) is real and correct — but it only supersedes a **new connection under
the same session_id**.

Claude Code does **not** guarantee a stable session id across an agent's logical life: resume
keeps the id; **fork mints a new id** (no parent-ref field); **`/clear`, `/compact`,
crash-restart are undocumented** (see `reference_claude_code_session_id_stability`).

When a new id represents the same logical agent, the broker treats it as a stranger: the
predecessor's row stays `active` (disconnect releases neither name nor the 15-day expiry), the
replacement's name claim hits the taken-branch (`store.ts:210-216`) → parked `pending` (which
reserves nothing — `markPending` NULLs the name, `store.ts:240-243`), `register()` still
returns success with `awardedSessionName:null` (`store.ts:407-411`), and queued messages stay
pinned to the dead id (`deliveries.recipient_session_id`/`messages.recipient_session_id` frozen
at send). Reproduced deterministically in `tests/integration/session-identity-reclaim.test.ts`.

## Decision (revised)

Introduce a **durable logical identity** (`logical_identity_id`) and key the routable name +
the entire inbox on it — **not** on the transient `session_id`. A new `session_id` that belongs
to the same logical identity then sees its name and inbox with **zero row movement**. Reclaim
is a single pointer update, liveness-gated so a **live incumbent is never evicted**.

> **Implementation mechanism — canonical-session redirection (equivalent to native keying,
> lower exactly-once risk).** The durable `logical_identity_id` is realized as a **canonical
> `session_id`** (for a fresh session, its own id). A reclaiming successor presenting a NEW
> physical CC session id is **redirected** to the canonical id via a `physical_session_map`
> and then flows through the EXISTING, already-tested supersede path (`store.ts:308-334`): the
> broker issues its `SessionAuthority` with `sessionId = <canonical id>`, bumps the epoch, and
> re-queues in-flight rows — exactly as a same-id supersede does today. The inbox
> (`deliveries`/`messages`/`receipts`/`context_injections`, all keyed on the canonical
> `session_id`) is therefore **never moved or re-keyed**, and the epoch-fenced ack/reply +
> injection-dedup + idempotency machinery is **unchanged and already exactly-once-correct
> across an epoch bump**. This achieves the same invariant native keying would (the inbox is
> keyed on a durable identity) while touching none of the 81 `recipient_session_id` call
> sites. `name_ownership` is the ownership/secret/reclaim authority; `sessions.session_name`
> on the canonical row is a strict same-transaction projection (they are 1:1 and cannot
> diverge). This is why the migration adds `physical_session_map` + `name_ownership` rather
> than a `recipient_logical_id` column on five tables.
>
> **Why not the re-point.** The first draft re-pointed a predecessor's
> `deliveries`/`recipient_sequences` to the successor's `session_id`. The design review proved
> that unsound: `ack()`/`reply()` authorize on `messages.recipient_session_id` (delivery.ts:646,
> 707) which the re-point can't safely move (collides with `ux_recipseq`, migrations.ts:124);
> injection dedup + receipts idempotency are session-keyed (both sessions commonly at epoch 0 →
> body suppressed / double-ack); and `accepted` (acked, reply-pending) deliveries are
> non-terminal yet fall outside the move-set. Keying on `logical_identity_id` dissolves all four.

### The four separated concepts

| concept | today | beta.8 |
|---|---|---|
| durable logical identity | *(absent — conflated with session_id)* | **`logical_identity_id`** — owns name + inbox |
| runtime generation | `active_epoch` / `session_epochs` / `fencing_token` | unchanged |
| connection instance | `component_instances` | unchanged |
| routable name + aliases | columns on `sessions(session_id)` | owned by `logical_identity_id` via `name_ownership` |

### D1 — `logical_identity_id` (v10) — as-shipped scope

> **Correction (beta.9.1 honesty pass).** The bullet list below was a DRAFT proposal for
> native-keying the inbox tables with a `recipient_logical_id`/`receiver_logical_id` column on
> five tables. **Only `sessions.logical_identity_id` shipped** (plus the `name_ownership` /
> `physical_session_map` tables — see the implementation box above and migration v10 in
> `src/database/migrations.ts`). The per-table `recipient_logical_id` / `receiver_logical_id`
> columns, the `recipient_sequences` re-key, and the `ux_recipseq` re-key **were NOT implemented**
> (`git grep recipient_logical_id -- src` = 0 hits; `ux_recipseq` remains keyed on
> `recipient_session_id`). Continuity is achieved by CANONICAL-SESSION REDIRECTION
> (`physical_session_map`), not native keying — see D4. The draft text is retained struck-through
> for provenance:

`ALTER TABLE sessions ADD COLUMN logical_identity_id TEXT;` shipped. The following per-table
columns were proposed but **NOT implemented** (superseded by canonical-session redirection):

- ~~`deliveries.recipient_logical_id`~~ (not shipped)
- ~~`messages.recipient_logical_id`~~ (not shipped)
- ~~`recipient_sequences` re-keyed to `recipient_logical_id`~~ (not shipped; still keyed on `recipient_session_id`)
- ~~`receipts.receiver_logical_id`~~ (not shipped)
- ~~`context_injections.recipient_logical_id`~~ (not shipped; dedup keys on `recipient_epoch`)

**Backfill (as-shipped):** the v10 migration sets every existing session's
`sessions.logical_identity_id = session_id` (each existing physical session becomes its own
logical identity — no historical grouping exists) and backfills `name_ownership`. New
registrations mint a fresh `logical_identity_id` (UUIDv7) unless a reclaim proof matches an
existing identity. `ack()`/`reply()`/`checkpointPull`/injection-dedup/idempotency authorize and
de-dupe on `recipient_session_id` + `recipient_epoch` (the successor resolves to the canonical
`session_id` via `physical_session_map`), NOT on a per-table `recipient_logical_id`.

### D2 — `name_ownership` table (v10), the SINGLE name authority

```sql
CREATE TABLE name_ownership (
  logical_identity_id TEXT PRIMARY KEY,
  normalized_name     TEXT,                 -- casefolded routing key (NULL when not holding a name)
  display_name        TEXT,
  owner_secret_hash   TEXT,                 -- sha256(secret); NULL = legacy-unprotected
  name_state          TEXT NOT NULL,        -- 'active' | 'pending' | 'released'
  current_session_id  TEXT,                 -- the session_id this identity is currently routed to
  superseded_at       TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_name_ownership_active ON name_ownership(normalized_name)
  WHERE normalized_name IS NOT NULL AND name_state IN ('active','pending');
```

**v10 backfill (same transaction) — REQUIRED (else upgraded beta.7 names are un-reclaimable):**

```sql
INSERT INTO name_ownership
  (logical_identity_id, normalized_name, display_name, owner_secret_hash,
   name_state, current_session_id, created_at, updated_at)
SELECT session_id, normalized_session_name, session_name, NULL,
       session_name_state, session_id, created_at, updated_at
FROM sessions
WHERE normalized_session_name IS NOT NULL AND session_name_state IN ('active','pending');
```

`owner_secret_hash NULL` = legacy-unprotected (D5). Lossless because `ux_session_name_active`
already guarantees source uniqueness.

**Single authority:** `resolveRecipient`, `claimNameForRegister`, `renameSession`, and the
reaper all read/write `name_ownership` as the source of truth for the routable name; the
`sessions` name columns become a derived projection kept in the same transaction (so the
console + legacy reads are unchanged). The reaper, on expiry, sets `name_ownership.name_state=
'released'` and clears `normalized_name` in the same sweep (no orphan ownership row).

### D3 — the register/reclaim algorithm (liveness-gated)

On `register` with a `requestedSessionName` **and** an `ownerSecret`:

1. Look up `name_ownership` by `normalized_name`.
2. If a row exists and `owner_secret_hash === sha256(ownerSecret)`:
   - **Liveness gate (Blocker 3):** if the identity's `current_session_id` still has a **live
     mcp component** (`component_instances … role='mcp' AND state='live'`), the incumbent is
     alive → **do NOT reclaim**. Fall back to beta.7 pending + `nameReclaimFailed`. Possession
     of the secret proves "same trust boundary", not "sole successor". A live owner is never
     evicted by a cross-id reclaim.
   - Else (incumbent gone — post-`onConnClose`, disconnected, or expired) → **legitimate
     reclaim:** force-close any residual live components of the predecessor (correct reason:
     a surviving predecessor MCP would otherwise still ack/route inbox rows now owned by the
     identity — genuine dual-live-owner, not a split-brain false-block); set the successor's
     `sessions.logical_identity_id` = the reclaimed identity; `UPDATE name_ownership SET
     current_session_id = <new sid>, name_state='active', updated_at=…`. **No inbox rows
     move** — they are already keyed on `logical_identity_id`, so the successor sees them
     immediately. Emit `identity.reclaimed`. Award the name active; return `awardedSessionName`.
3. If a row exists and the secret is absent/wrong → **no reclaim**: behave exactly as beta.7
   (taken-branch → pending, `awardedSessionName:null`). A peer that guessed a name but not the
   secret gains nothing.
4. If no row exists → first claim: mint `logical_identity_id`, mint a stable `ownerSecret`,
   insert `name_ownership` active, award the name.

The owner secret is **stable across reclaims** (Major — no per-reclaim rotation; see D5),
rotated only on explicit operator/rename request, so a crash between broker-commit and the
client's file-write can never self-lock the identity out.

### D4 — inbox continuity & exactly-once (as-shipped: canonical-session redirection)

**Correction (beta.9.1 honesty pass).** An earlier draft of this section described a
`recipient_logical_id` NATIVE-KEYING design — the inbox keyed on `logical_identity_id`, and
delivery.ts ack/reply authorization switching from `messages.recipient_session_id` to
`recipient_logical_id`, with injection dedup keyed `(message_id, recipient_logical_id, logical#)`.
**That design was never implemented.** `git grep recipient_logical_id -- src` returns zero hits;
the shipped ack/reply path authorizes on `recipient_session_id` (delivery.ts), and injection dedup
is keyed `(message_id, recipient_epoch, logical_injection_number)` (`ux_injection_logical`). The
earlier text also claimed a "reclaim-after-partial-ack completes the reply" test existed; **it did
not** — the reclaim tests exercised only reclaim→ack→reply (queued-inbox inheritance), never
ack→reclaim→reply. This section is corrected to describe what actually shipped.

**As-shipped design — canonical-session redirection (see the implementation box above).** The
inbox is keyed on the CANONICAL `session_id`. A successor under a new physical `session_id` is
REDIRECTED onto the canonical id via `physical_session_map`, so it:
- pulls the identity's queued deliveries directly (they already sit on the canonical id — no row
  movement, no re-point);
- acks/replies under the canonical `session_id` its connection resolves to;
- injection dedup keys `(message_id, recipient_epoch, logical#)` — at-most-once per epoch.

**Reply-pending continuity across an epoch bump (BLOCKER #3, beta.9.1).** A reclaim/supersede
advances the epoch (N→N+1). A delivery in `queued`/`transport_written` is re-homed to the new
epoch normally. An `accepted` (acked, reply-still-owed) delivery is the subtle case: its body was
already presented AND acknowledged, so it MUST NOT be re-injected (that would duplicate
model-visible work and break at-most-once). But its reply is still owed, and `receipts.authorize`
gates reply on a `context_injections` row for the CURRENT (message, session, epoch) — which the
successor's new epoch lacks. Left unhandled the obligation was a permanent orphan (invisible,
unrepliable, never reaped). The fix (`store.rehomeAcceptedReplyAuthority`) re-homes only the REPLY
AUTHORITY: it mints a fresh authority-only `context_injections` row for epoch N+1 (a NEW
(message, epoch, logical#1) tuple — never reusing the epoch-N row, so `ux_injection_logical` holds),
WITHOUT re-queuing the delivery. The delivery stays `accepted`; `inboxView` surfaces the
cross-epoch accepted-reply-pending row (`bodyIncluded:false`, action `reply`) so the successor can
DISCOVER and complete it; exactly one reply completes the original; the superseded epoch stays
fenced (`assertCurrentEpoch` + epoch-scoped injection).

**Expiry (BLOCKER #3, beta.9.1).** An `accepted` reply-pending delivery on a session that simply
idles past the 15-day horizon (no reclaim) was also orphaned — the expiry sweep dead-lettered
`queued`/`retry_wait`/`transport_written` but EXCLUDED `accepted`, leaving it immortal. The reaper
now transitions such rows to `expired` with a DISTINCT `failure_category='reply_pending_unanswered_15_days'`
(preserving `application_accepted_at`), NOT the generic `recipient_inactive_15_days` bucket — so an
observer can distinguish never-delivered / delivered-but-unacked / acked-but-reply-outstanding /
acked-but-abandoned-on-expiry, rather than the defect being silently reaped away.

Tests (`tests/integration/reply-pending-orphan.test.ts`, RED-first at the beta.9 tag): a successor
completes the outstanding reply WITHOUT body re-injection; the old epoch is fenced; exactly one
reply completes; the obligation survives a broker restart; on pure expiry the accepted row reaches
the explicit observable terminal above. Redelivery-after-reclaim de-dup and queued-inbox
inheritance remain covered by the existing reclaim tests.

### D5 — event-driven reclaim window; stable secret

A protected identity is reclaimable immediately by secret once its incumbent is gone (D3
liveness gate) — no 15-day wait. Unprotected (legacy `owner_secret_hash IS NULL`) names keep
beta.7 behavior exactly (reaper-driven release only). The owner secret is adopted atomically
and kept stable across reclaims (mirrors `root-secret.ts`); rotation is an explicit
operator/rename act, optionally two-phase (broker accepts the prior hash until the client
confirms durable persistence of a new one).

### D6 — honest registration outcome

The ack surfaces `sessionNameState`. Beta.8 adds `nameReclaimFailed:true` when a
`requestedSessionName`+`ownerSecret` was sent but reclaim was refused (wrong secret, or live
incumbent). **Oracle note:** `nameReclaimFailed` reveals that a protected name exists (same-user
enumeration oracle). Since names are already discoverable via `listActiveNamedSessions` within
the same-user trust boundary, this leaks nothing new; we still return the plain pending outcome
for the absent-name case so the two are indistinguishable to a probe.

### D7 — audit / ledger; secret never logged

New runtime-only ledger event types: `name.superseded`, `identity.reclaimed`. Emitted through
the hash-chained ledger in the same transaction; **never backfilled** (append-only triggers
abort UPDATE/DELETE). **Invariant + test:** the plaintext `ownerSecret` MUST NOT appear in
`audit_events`, `ledger_events`, or any log — it is returned only via a distinct ack field the
audit/ledger path never sees (only its sha256 hash is persisted, in `owner_secret_hash`).

## Ownership-proof delivery (client side) — agent-unique anchor

The MCP server persists the awarded `ownerSecret` to a file under the ACL-protected data dir,
keyed by `project_id` **+ the normalized session name** being (re)claimed. (The awarded
`logical_identity_id` is also stored in the record as a secondary marker, but the LOOKUP key is
`project_id`+name — a successor under a brand-new session id must find its secret *before* it
knows its logical identity, which only the name it is requesting can anchor. Keying the lookup
on the identity id would be un-bootstrappable.) Consequences of the name anchor, and why it is
safe:
- a session that was only ever `pending` never receives an `ownerSecret` in its ack, so it
  never persists one and cannot select the true owner's secret;
- two agents in the same repo requesting **different** names get **distinct** files;
- two agents requesting the **same** auto-derived name in one repo DO share the file — this is
  the genuinely ambiguous case. The broker's **liveness gate is the authoritative backstop**:
  a reclaim is refused while the current holder has a live mcp component (`resolveReclaim` →
  `hasLiveMcp`), so the second session lands `pending`+`nameReclaimFailed`, exactly as beta.7 —
  the live owner is never evicted;
- **`--fork-session`** mints a new session id whose MCP would request the same auto-name and
  could load the parent's secret, but the parent is still LIVE, so the liveness gate refuses the
  reclaim — the fork lands `pending`, never supersedes its parent.

> **Design note (revised after impl review):** an earlier draft mandated anchoring the lookup
> on the awarded `logical_identity_id` "never the name". That is un-bootstrappable (a fresh
> session id has no identity id to look up by), so the implemented + correct anchor is
> `project_id`+name with the liveness gate as the security-relevant backstop. The identity id is
> retained in the record for diagnostics and a future exact-match tightening.

> **Same-user framing (honest — Major fix).** One broker == one OS user == one dataDir; the
> ACL protects the secret only against **other** OS users (`acl.ts`). Every actor that can
> reach the broker to attempt a reclaim is the same OS user and can also read the secret file.
> So the secret is **not** a defense against a hostile same-user peer — it prevents a fresh
> same-user session that has **not** read the file from **accidentally** reclaiming, and gives
> the legitimate successor automatic continuity. Cross-user protection is the ACL, not the
> secret. (Consistent with README "Honest limitations": same-user software, not a same-user
> sandbox.)

## Wire compatibility

`SCHEMA_VERSION` → 10 ⇒ dynamic handshake tuple `xbus-p1-stp1-s10`; fail-closed handshake
unchanged (an s9 component meeting an s10 broker is rejected `upgrade_component`; beta.8 is a
controlled whole-install upgrade, ADR 0019). **The adapter-SDK `FROZEN_PROTOCOL_COMPAT`
baseline (s5) is deliberately independent of the dynamic tuple and MUST NOT be bumped** for
beta.8. `ownerSecret` / `nameReclaimFailed` are additive, unknown-field-tolerant payload
fields — a beta.7 client that never sends a secret gets exact beta.7 behavior.

## Known minor behaviors (accepted)

- **Reclaim of an EXPIRED predecessor.** Once the 15-day reaper expires a session it releases
  the `name_ownership` row (`name_state='released'`, `normalized_name=NULL`). `resolveReclaim`
  only matches `active`/`pending` rows, so a successor presenting the old secret for a
  long-expired name does **not** reclaim — it falls through to a fresh first-claim (a new
  identity + new secret). This is correct: an identity idle for 15 days legitimately lost its
  name to the pool. The client silently re-persists the new secret; no data is lost (the
  expired inbox was already dead-lettered at expiry). Accepted as-is for beta.8.

## Phase 3 regression audit (beta.8) — outcome

A 5-area lifecycle audit (registration/naming/resume, delivery/ack/reply/restart,
scheduler/idle-wake, install/upgrade/rollback, dashboard) with adversarial per-finding
verification produced: 7 major candidates refuted as false positives (e.g. no runtime path
writes a `cancelled` delivery state; reply-implies-ack is intentional; the operator row is
filtered; dead-letter redrive already re-presents correctly), and **3 confirmed, all narrow
pre-existing beta.7 minors** — none related to session continuity, none introduced by this
work:

- **FIXED — scheduler transient-recipient exhaustion:** a `once` schedule whose target was
  only *transiently* unresolvable (`UNKNOWN_RECIPIENT`/`AMBIGUOUS_RECIPIENT` — not yet
  registered / momentarily ambiguous) was terminally exhausted instead of deferred. Now such
  errors DEFER (retry next tick, schedule stays alive), mirroring quiet-hours deferral;
  genuinely permanent errors (expired/blocked/self) stay terminal. Regression-tested.
- **DEFERRED (documented) — migration-backup root-secret copy:** the one-time data-migration
  backup dir retains a copy of the root secret. It inherits the same owner-only ACL as the
  live secret (`hardenDir` runs first) and the legacy source retains the secret anyway, so
  there is no *additional* cross-user exposure — a hygiene gap, not a vuln. Reclaim/cleanup
  hardening deferred to avoid install-path surgery late in this cycle.
- **RESOLVED in beta.12 (#315) — legacy-source data-safety + the "never mutated" invariant.**
  The original deferral (below) understated two things, corrected here after empirical study
  (two independent drive-throughs of the real `migrateDataRoot`):
  - *The "never mutated" claim was FALSE.* `summarizeRoot→inspectDb` opened the source DB
    read-WRITE; when it was the sole holder of a crashed source (uncheckpointed `-wal`, no live
    process) its close() checkpointed the `-wal` into the main file — a real byte mutation, and it
    fired even on `dryRun` (a supposed no-op) and the conflict-abort path.
  - *The mutation was semantically preserving — NO row was ever lost.* The checkpoint merges
    committed WAL frames; migrations still promoted complete (verified 5× crashed-broker: 31/31).
  beta.12 fix: **inspection is READ-ONLY** (`inspectDb` opens `{ readOnly: true }`). A read-only
  handle reads all rows *through* an uncheckpointed `-wal` without checkpointing, so the legacy
  source is byte-identical on every path (migrate / dryRun / conflict). Empirically established
  data-safety (no broker-stop required — deliberately NOT added, to avoid new process-control risk):
  - a **live/active-writing** legacy broker → migration promotes a COMPLETE copy (whole-root copy
    captures main + `-wal`), source intact;
  - a **separate-process live holder** keeping an unmerged `-wal` across the copy → the staged copy
    (sole-held → checkpoints on close) hashes differently from the still-unmerged source → the
    `staged==source` gate **fails closed** (rollback), never a torn/lossy promote;
  - the legacy source is never mutated or deleted → always recoverable.
  THE CONTRACT (precise, test-backed): *migration inspection and dry-run open the legacy database
  read-only and modify none of its DB/WAL/SHM/ledger/secret/ownership bytes; a successful migration
  promotes only a verified-complete destination snapshot; a live-holder race fails closed; failure
  leaves the legacy installation independently usable.* (Original deferral, for history: "guarded by
  a post-copy hash compare + integrity_check that abort fail-closed … narrow torn-copy window" —
  accurate that it never lost data, but the source WAS mutated and the window was not the real risk.)

## Consequences

- **Positive:** a legitimate successor recovers its name + inbox automatically and exactly once
  with zero row movement; register/rename never silently report a false name award; a live
  incumbent is never evicted; the change is additive and preserves all beta.7 data + semantics
  for unprotected names.
- **Negative / accepted:** the owner secret lives in the ACL-protected data dir (same-user
  trust boundary — accident-prevention + continuity, not same-user hijack defense);
  `/clear`+`/compact` id-stability remain undocumented upstream, so continuity there is proven
  empirically in Phase 6, not assumed.

## Risks (tracked, each with a test)

- **R1 accidental reclaim / same-user framing:** secret prevents an uninformed fresh session
  from accidentally reclaiming and gives the legit successor continuity; it is NOT a defense
  against a hostile same-user peer (that peer reads the file) — cross-user is the ACL's job.
  Test: wrong/absent secret ⇒ no reclaim, predecessor keeps the name.
- **R2 exactly-once across identity change:** canonical-session redirection + epoch fencing (D4,
  as-shipped — NOT the never-implemented native `recipient_logical_id` keying). Tests: reclaim
  inherits the queued inbox (`session-identity-reclaim-fix`); redelivery-after-reclaim de-dupes
  (`inbox-dedup`); a reply-pending `accepted` delivery survives an epoch bump AND pure expiry with
  no body re-injection, old epoch fenced, exactly one reply, explicit observable expiry terminal
  (`reply-pending-orphan`, beta.9.1 BLOCKER #3, RED-first at the beta.9 tag).
- **R3 dual-live-owner:** reclaim force-closes residual predecessor components — but only once
  the incumbent is confirmed gone (D3 liveness gate); a live incumbent is refused, not evicted.
  Test: reclaim of a disconnected predecessor succeeds; reclaim against a live incumbent is
  refused and returns pending.
- **R4 two name authorities:** collapsed to one — `name_ownership` (D2); reaper transitions it
  in the same sweep. Test: `resolveRecipient(name)` returns the NEW session id post-reclaim and
  reclaim of a disconnected-but-unexpired predecessor commits with no `ux_session_name_active`
  violation.
- **R5 self-lockout:** owner secret stable across reclaims (D5). Test: crash after
  reclaim-commit before file-write ⇒ successor still reclaims with the pre-rotation secret.
- **R6 migration completeness:** v10 backfills BOTH `logical_identity_id` and `name_ownership`
  in-transaction (checksum-frozen). Test: a name existing before v10 is reclaimable and the two
  name representations never diverge at rest.
