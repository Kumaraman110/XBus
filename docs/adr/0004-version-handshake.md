# ADR 0004 — Broker/plugin version + protocol handshake

**Status:** Accepted · **Date:** 2026-06-25 · Triggered by the live-test "stale broker" incident.

## Problem
During the live test a broker process running OLD code (before a new frame type
existed) silently rejected the hook's frame, so injection failed with no clear
signal. Mixed broker/plugin versions must be detected and refused, not limped
through.

## Decision
Every connection's `hello` carries full version info:
`{ xbusVersion, protocolVersion, minimumProtocolVersion, maximumProtocolVersion,
schemaVersion, componentRole, buildId, capabilities }`. The broker replies with
its equivalent + a **compatibility verdict**, computed by the pure
`checkCompatibility()`:

| Condition | Verdict | ok |
|---|---|---|
| protocol ranges overlap AND equal schema | `compatible` | yes |
| no overlap, client max < broker min | `upgrade_component` | no |
| no overlap, broker max < client min | `upgrade_broker` | no |
| client schema > broker schema (broker older) | `restart_broker` | no |
| client schema < broker schema (client older) | `upgrade_component` | no |

The live DB schema is owned by whichever build started the broker (it ran the
migrations), so schema mismatch is decisive.

Rules enforced:
- **Incompatible clients fail BEFORE registration** — `onHello` throws a typed
  `XBUS_VERSION_INCOMPATIBLE` error carrying the verdict; the connection never
  enters the hello'd set, so `register_session` is blocked.
- **No unknown frame is silently ignored** — the default switch arm returns a
  typed `XBUS_PROTOCOL_VIOLATION`.
- **`xbus doctor`** reports broker endpoint, PID (from `broker.pid`), version,
  buildId, protocol, schema, and the compatibility verdict for THIS build.
- **`xbus stop`/`restart`** target ONLY the PID recorded in `broker.pid` by the
  running broker — never kill by process name.
- A legacy minimal hello (`{protocolVersion}` only) is tolerated by defaulting
  min/max to that version and schema to current (back-compat for internal tests).

## Consequences
- `src/protocol/handshake.ts` (pure verdict), `src/ipc/hello.ts` (clientHello +
  doHello that throws an actionable error). MCP server / hook / CLI all send the
  full hello via `doHello`.
- `BUILD_ID = xbus-<ver>-p<proto>-s<schema>` distinguishes builds.
- Tests: 7 unit (matrix) + 5 integration (fail-before-register, unknown-frame,
  schema-too-new→restart_broker, no-overlap→upgrade_component).
- Bounded handshake: the IpcClient request timeout already bounds a hung
  handshake; a stale/unreachable broker surfaces as `BROKER_UNAVAILABLE` in doctor.
