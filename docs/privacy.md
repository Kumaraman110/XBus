# Privacy

XBus is **local-only**. It runs entirely on your machine, under your OS user.

## What XBus stores, and where

Everything lives in the per-user data directory — `<install-root>/data` for an
installed instance (default `~/.claude/xbus-install/data`), or `~/.claude/xbus`
when running from source; overridable with `XBUS_DATA_DIR`:

- `xbus.sqlite` (+ WAL/SHM) — the durable store: sessions, aliases, messages
  (**including message bodies**), deliveries, receipts, audit events.
- `auth/root.secret` — the 256-bit installation secret for the secure transport.
- `broker.state.json` — the running broker's identity (pid, instance id, endpoint).

All of these are restricted to the owning OS user (Windows ACL / Unix mode).

## What leaves your machine

**Nothing.** XBus performs no network I/O of its own — there is no telemetry, no
analytics, no phone-home, no remote logging. Communication is between local
processes over a local named pipe / Unix socket only.

(Your Claude Code sessions themselves talk to your configured model provider —
that is Claude Code's behaviour, not XBus's. XBus does not add any external call.)

## Message content

- Message **bodies are stored in the local SQLite database** so they can be
  delivered durably and survive a broker restart. They are readable by your OS
  user (as is any file you own).
- **Audit events and logs never contain message bodies.** They carry only safe
  identifiers (message id, session, alias, attempt counters, state). This is
  enforced and tested (`tests/integration/reliability-matrix.test.ts` scans audit
  rows for body leakage; the broker uses a redaction helper for logged fields).
- The model-visible `injection_id` is a **non-secret** reference, safe to appear
  in transcripts.

## Retention

Terminal delivery records, receipts, and audit rows are retained for a bounded
window (default 7 days) and then pruneable. Message bodies persist until their
delivery reaches a terminal state and ages out of retention. Removing the data
directory removes everything; the uninstall path that does this (and preserves
unrelated files) is exercised by
[`tests/integration/artifact-first-install.test.ts`](../tests/integration/artifact-first-install.test.ts).

## Your control

- Set `XBUS_DATA_DIR` to relocate or isolate the store.
- Delete the data directory to erase all XBus state.
- Block a peer (`xbus block <alias>`) to stop receiving from it.
