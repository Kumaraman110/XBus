# Adapter support levels (Tier 0–5)

> **Status: DESIGN_COMPLETE (planning).** Canonical plan:
> [`docs/roadmap/universal-xbus.md`](../roadmap/universal-xbus.md) §4/§6. Machine-readable
> matrix: [`compatibility/platforms.json`](../../compatibility/platforms.json).

| Tier | Internal | Max ready state | Requirements (cumulative) | Public label |
|---|---|---|---|---|
| 0 | `unsupported` | — | fails handshake | "not supported" |
| 1 | `send_only` | n/a | hello + register + send | "send-only integration (community)" |
| 2 | `manual_receive` | `ready_manual` | + ack + explicit pull | "manual-pull integration (community)" |
| 3 | `checkpoint_receive` | `ready_checkpoint` | + native lifecycle checkpoint + `mark_injected` | "checkpoint integration (community)" |
| 4 | `live_receive` | `ready_live` | + structural between-turn push + deadline-safe ack | "live integration (community)" |
| 5 | `reference` | `ready_live` + full degraded/reconnect | tier 4 + reaper/redeliver/takeover exercised by a conformance suite | "reference adapter" |

## The two-column honesty rule

- **`platformCeilingTier`** — the tier a runtime's *vendor surfaces* could support. A
  design target (detected/designed). Derived from official docs.
- **`awardedTier`** — the tier with *runtime evidence today*. **T0/T1 until a real adapter
  + a passing §15 R1–R4 runtime log exists.**

These are **different columns** and must never be conflated. Hard gates: no Tier ≥ 2 award
without a passing R1–R4 log; no Tier ≥ 4 without a non-Bedrock transport proving
`ready_live`; no Tier 5 until the conformance suite exists. **The broker caps the awarded
tier by handshake evidence — a manifest cannot self-promote.**

## Today's reality

The **only** runtime-validated adapter is **Claude Code at Tier 3 / `ready_checkpoint` on
Bedrock**. `ready_live` (Tier 4/5) is not demonstrable on Bedrock (no between-turn push) —
theoretical. `(community)` is mandatory on Tiers 1–4 (non-affiliation); Tier 5 "reference"
is reserved for adapters passing the (not-yet-built) conformance suite.

See [`docs/roadmap/universal-xbus.md` §7](../roadmap/universal-xbus.md) for the ranked
prioritization and per-runtime ceilings.
