# ADR 0005 — People-facing scheduling policy + receipt-control state

**Status:** Accepted (policy + core state); commands partially implemented · **Date:** 2026-06-25

## Principles (defaults, conservative)
1. **The human prompt has priority.** Peer messages are delivered as clearly
   marked, separate `<untrusted_xbus_peer_messages>` content; they never replace
   or rewrite the human's task.
2. **Peer processing is visible**, never silent. The injection block and the
   per-checkpoint cap are observable.
3. **Automatic Stop continuation stays OFF by default** (`XBUS_AUTO_CONTINUE_ON_STOP`
   opt-in). No automatic agent-to-agent reply loops: a reply does not itself
   trigger another reply unless the receiving session explicitly processes a new
   request.
4. **Bounded per checkpoint:** `maxMessagesPerCheckpoint` (default 10),
   `maxPeerProcessingMs` budget, `maxAdditionalModelTurns` (default 0 = no extra
   turns beyond the natural checkpoint; Stop draining is the only opt-in path).
5. **User can pause/resume receipt, inspect the queue, and block a peer alias.**
6. **Degraded receive mode stays visible** (`xbus sessions` shows the real mode).

## Core state (migration v3)
```
session_controls(session_id PK, receiving INTEGER NOT NULL DEFAULT 1,
                 paused_at TEXT, updated_at TEXT)
blocked_peers(id PK, owner_session_id, blocked_alias_ci, created_at,
              UNIQUE(owner_session_id, blocked_alias_ci))
```
- When a session is **paused** (`receiving=0`), the hook checkpoint pull returns
  nothing (messages stay durably queued); `xbus sessions` shows `paused`.
- When a peer alias is **blocked** by the recipient, `xbus_send` from that peer
  to this recipient is refused at send time (`XBUS_BLOCKED`), and any already
  queued messages from it are withheld from checkpoint pulls.

## Command contracts
| Command | Contract |
|---|---|
| `xbus pause` | set `receiving=0` for the caller's session; queued messages persist; returns paused state |
| `xbus resume` | set `receiving=1`; next checkpoint delivers the backlog in sequence |
| `xbus inbox` | list queued messages for the caller (peek; does not mark injected) |
| `xbus process-next` | inject + return exactly the next 1 queued message (manual single-step) |
| `xbus block <alias>` | add `<alias>` to the caller's blocked list; refuse future sends; withhold queued |
| `xbus unblock <alias>` | remove from blocked list |

## Status (honest)
- **Designed now** (this ADR) + core state schema (migration v3) + the broker-side
  pause/block ENFORCEMENT in the pull/send paths.
- **CLI command wiring** (`pause`/`resume`/`process-next`/`block`/`unblock`) is
  stubbed with contracts; full implementation lands in the broader-CLI step. The
  policy + enforcement state exist now so behavior is not accidentally locked in
  wrong by the reliability work.
