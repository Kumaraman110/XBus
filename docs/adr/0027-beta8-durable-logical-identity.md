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

### D1 — `logical_identity_id` everywhere the inbox is keyed (v10)

`ALTER TABLE sessions ADD COLUMN logical_identity_id TEXT;` plus the SAME column added to the
inbox-bearing tables so routing resolves on the durable identity:

- `deliveries.recipient_logical_id`
- `messages.recipient_logical_id` (and the per-recipient sequence space keys on it)
- `recipient_sequences` re-keyed to `recipient_logical_id` (PK)
- `receipts.receiver_logical_id`
- `context_injections.recipient_logical_id`

**Backfill (same migration transaction, additive, lossless):** set every existing row's
`logical_identity_id` / `recipient_logical_id` / `receiver_logical_id` = the row's current
`session_id` (each existing physical session becomes its own logical identity — no historical
grouping exists). The unique index `ux_recipseq` becomes `(recipient_logical_id,
recipient_sequence)`; because the backfill maps 1:1 session→identity, no existing row collides.

New registrations mint a fresh `logical_identity_id` (UUIDv7) unless a reclaim proof matches an
existing identity. `ack()`/`reply()`/`checkpointPull`/injection-dedup/idempotency all authorize
and de-dupe on `recipient_logical_id` (the durable identity), never `session_id`.

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

### D4 — inbox continuity & exactly-once (native keying)

Because the inbox is keyed on `logical_identity_id`, a successor under a new `session_id`:
- pulls the identity's queued deliveries directly (no re-point);
- acks/replies via `recipient_logical_id` authorization (delivery.ts paths switch from
  `messages.recipient_session_id` to `recipient_logical_id`);
- injection dedup keys `(message_id, recipient_logical_id, logical#)` so the body is presented
  exactly once regardless of the epoch-0 collision that broke the re-point;
- `accepted` (reply-pending) deliveries need no move — they're already the identity's.

Tests assert: reclaim-after-partial-ack completes the reply; redelivery after reclaim de-dupes;
predecessor+successor both at epoch 0 present the moved body exactly once.

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
keyed by an **agent-unique** anchor: `project_id` **+ a persisted per-awarded-identity id**
(the `logical_identity_id` the broker returns at first award), **never** the workspace-derived
suggested name. Both the write and the read key on the **awarded** identity, so:
- a session that was only ever `pending` cannot select the true owner's secret;
- two different agents in the same repo do not collide (each has its own awarded identity id);
- **`--fork-session` gets a NEW identity, never reclaims the parent** — the fork has no awarded
  identity id yet, and the liveness gate refuses reclaim of the still-live parent anyway;
- if `>1` live session shares the anchor, the MCP server refuses to auto-present (no ambiguous
  reclaim).

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
- **R2 exactly-once across identity change:** native `logical_identity_id` keying (D1/D4).
  Test: reclaim after partial ack; redelivery de-dupes; epoch-0 body presented once.
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
