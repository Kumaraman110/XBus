# ADR 0007 — Identity-verified broker shutdown (no PID-only kill)

**Status:** Accepted · **Date:** 2026-06-25 · Replaces the `broker.pid`-only stop.

## Problem
`xbus stop` killed whatever PID was in `broker.pid`. A reused PID or a stale file
could make it terminate an **unrelated process**. Stopping must be identity-verified.

## Decision
1. **Normal path = authenticated IPC shutdown.** `xbus stop` connects as an
   ADMIN-role component and sends a `shutdown` frame echoing the broker's
   `brokerInstanceId`; the broker verifies role + instance match, acks, then stops
   gracefully (drains, closes IPC, removes its own state file).
2. **Rich state file** `broker.state.json` (atomic write, `0600`):
   `{ pid, processStartedAt, brokerInstanceId, buildId, endpoint, ownerIdentityHash }`.
   Owner is a **hash** (`sha256(username:uid)`), never the raw username.
3. **Forced kill is a fallback, gated by `classifyShutdown()`** which returns:
   - `none` — no state file, or PID not alive (stale → safe to remove);
   - `refuse` — owner-hash mismatch (different OS user) OR instance-id mismatch
     (possibly-reused PID / unrelated process) → **never signal**;
   - `ipc` — owned + alive (+ instance matches if expected) → try IPC; forced
     SIGTERM only if IPC fails AND the pid is still alive+verified.
   Liveness uses `process.kill(pid, 0)` (probe, not kill).
4. **`xbus doctor`** reports broker pid + instance + build + alive-state + the
   compatibility verdict. Build-id mismatch is surfaced, not auto-fatal.

A forced kill therefore runs ONLY for a process that is: owned by the same OS
user, alive, matching the recorded broker instance, and unreachable over IPC.
Never by process name.

## Tests (10 required + extras, none kills an unrelated process)
Valid IPC shutdown; stale PID; reused-PID guarded by instance-id; instance
mismatch; owner mismatch; build-id recorded; hung-broker → IPC-first; signal-0
liveness probe; concurrent stops classify safely; state file is owner-hash +
`0600`. Forced-kill *decisions* are asserted via `classifyShutdown`, never by
actually terminating a process.

## Consequences
- `src/broker/state-file.ts` (state IO + `classifyShutdown` + `pidIsAlive`).
- daemon `shutdown` frame (admin role + instanceId echo); host writes/removes the
  state file and wires `onShutdownRequested`; CLI `stop` does IPC-first + verified
  forced fallback; `doctor` reads the state file.
- The old `broker.pid` file is gone.
