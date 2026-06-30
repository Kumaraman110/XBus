# Architecture

XBus is a per-user, same-machine message bus. This document describes the
components, the identity model, and the delivery path. Detailed decisions live in
[`docs/adr/`](adr/).

## Components

```
┌──────────────────────────────────────────────────────────────────┐
│  one OS user, one machine                                          │
│                                                                    │
│   Claude session A                     Claude session B            │
│   ┌───────────────┐                    ┌───────────────┐           │
│   │ MCP server    │  xbus_* tools      │ MCP server    │           │
│   │ checkpoint hook│ (stdio)           │ checkpoint hook│          │
│   └──────┬────────┘                    └──────┬────────┘           │
│          │  XBUS-STP (encrypted IPC)          │                    │
│          ▼                                     ▼                    │
│        ┌──────────────────────────────────────────┐               │
│        │            broker (singleton)             │               │
│        │  routing · auth · scheduling · reaper     │               │
│        │  ┌────────────────────────────────────┐  │               │
│        │  │ node:sqlite (WAL) durable store     │  │               │
│        │  └────────────────────────────────────┘  │               │
│        └──────────────────────────────────────────┘               │
└──────────────────────────────────────────────────────────────────┘
```

- **Broker** — a per-user singleton process (Node + `node:sqlite`/WAL). Owns the
  durable store, recipient resolution, scheduling/controls, the receipt/authority
  ledger, and the reliability reaper. Enforced single instance per data dir.
- **MCP server** — one per Claude session; exposes the `xbus_*` tools
  (`xbus_send`, `xbus_inbox`, `xbus_ack`, `xbus_reply`, `xbus_redeliver`,
  `xbus_sessions`, `xbus_register`, `xbus_status`). It connects to the broker over
  the encrypted transport and registers the session.
- **Checkpoint hook** — delivers queued messages into the session's context at a
  lifecycle checkpoint (e.g. the next user prompt). See
  [delivery semantics](delivery-semantics.md) and [providers](providers.md).

## Identity model (ADR 0003)

Three layers, so authority survives reconnects without leaking across takeovers:

- **LogicalSession** — the stable session id (`CLAUDE_CODE_SESSION_ID`).
- **SessionEpoch** — advances only on a *proven supersede* (takeover / new owner),
  never on a mere component reconnect.
- **ComponentInstance** — a specific MCP/hook/CLI process+connection within an epoch.

Authority is **bound to the authenticated connection** (session + epoch + role),
not to a bearer token. The model only ever sees a **non-secret `injection_id`**
(ADR 0006), safe to appear in transcripts.

## Delivery path

1. `xbus_send` → broker resolves the recipient and **durably persists** the
   message (one row) before the ack returns.
2. The message is `queued`. When the recipient is **ready** (§2) and reaches a
   checkpoint, the hook/inbox pull injects it (`transport_written`) and issues a
   one-time receipt.
3. The receiver `xbus_ack`s (accept/reject), then optionally `xbus_reply`s. The
   reply is a correlated message back to the original sender (correlation +
   causation preserved).
4. The **reaper** reclaims ack-timeouts, acceptance-TTL expiries, and abandoned
   leases on a periodic sweep.

## Durable store

`node:sqlite` in WAL mode (ADR 0002 — chosen over `better-sqlite3` to avoid a
native-compile dependency). Schema is migration-versioned with checksum
verification and a downgrade guard. Key tables: `sessions`, `messages`,
`deliveries`, `context_injections` (the at-most-once ledger), `receipts`,
`delivery_leases`, `audit_events`.

## Secure transport

The IPC (named pipe / Unix socket) is treated as **untrusted** and wrapped by
**XBUS-STP** (ADR 0010): mutual installation-membership auth, per-frame
AES-256-GCM with per-connection HKDF keys, replay/reorder rejection, uniform
auth-failure. See [security](security.md) and
[secure-transport-spec](secure-transport-spec.md).

The XBUS-STP wire field historically named `buildId` carries the **stable
compatibility tuple** (`wireCompatibilityId`), not exact artifact identity — see the
build-identity model below.

## Build identity (ADR 0011)

Distinct from the session/component identity above, each *artifact* has an identity
made of four non-overlapping concepts (`src/shared/build-identity.ts`):

- **productVersion** — the human release id (e.g. `0.1.0-beta.2`).
- **buildId (exact)** — `xbus-<productVersion>-<shortCommit>`; deterministically
  identifies the exact source build. **Diagnostics only — never bound into the
  handshake.**
- **sourceCommit** — the full git commit SHA the artifact was built from.
- **compatibilityId** — `xbus-p<proto>-stp<stp>-s<schema>` (currently `xbus-p1-stp1-s6`);
  the STABLE, version-independent interop tuple **bound into the STP transcript** (it
  is the value the wire field named `buildId` carries). Builds interoperate iff it
  matches.

Exact identity is carried by the deterministic, checksum-covered `provenance.json`
emitted at packaging time and read at runtime (fail-closed). `xbus version` and
`xbus doctor` report the full model; the install manifest additionally records
`artifactManifestSha256` (the exact distributable id). The STP wire bytes and vectors
are unchanged by this model.

## State machine

Deliveries move through `queued → (dispatching) → transport_written → accepted →
completed`, with `retry_wait`, `expired`, `dead_letter`, `cancelled` as the
off-paths. The transition table is the single source of truth in
`src/protocol/states.ts`; persistence enforces it with compare-and-set.
