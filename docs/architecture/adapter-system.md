# Architecture: the XBus adapter system

> **Status: DESIGN_COMPLETE (planning).** Canonical plan:
> [`docs/roadmap/universal-xbus.md`](../roadmap/universal-xbus.md). This file is the
> architecture-focused view; the roadmap is the source of truth. Baseline
> `v0.1.0-beta.2` / `69b191f` is untouched.

## The boundary

```
  adapter packages  ──▶  @xbus/adapter-sdk  ──▶  @xbus/core
  (claude-code, …)          (the seam)        (broker/protocol/ipc/db/identity/obs/shared)

  CORE NEVER IMPORTS THE SDK OR AN ADAPTER.   THE SDK NEVER IMPORTS AN ADAPTER.
```

Compiler-enforced via `tsconfig` project references + an import-boundary lint.

XBus core is **already ~90 % vendor-neutral** at `69b191f`: `protocol/states.ts` is
"transport-agnostic"; the `hello` handshake already carries `{componentRole,
capabilities[]}`; `broker/readiness.ts` holds the lifecycle/injection-safety core;
`identity/components.ts` is a fail-closed role→operation MATRIX; `shared/build-identity.ts`
already ships `compatibilityId` (`xbus-p1-stp1-s5`) + a six-way `classifyMixedBuild`.
The Claude coupling is concentrated in `src/channel/*` + `launcher/xclaude.ts`, and the
single hard vendor dependency (`CLAUDE_CODE_SESSION_ID`) is read **only at the adapter
edge, never in the broker.**

## The seam (the SDK contract)

An adapter drives `IpcClient` via a typed `BrokerFacade` — every method maps **1:1 to an
existing `FrameType`**, so there are no new wire verbs and `xbus-p1-stp1-s5` is preserved.
See the `XBusAdapter` interface (`manifest / detect / capabilities / resolveIdentity /
register / receive / acknowledge / reply / health / shutdown`) and `BrokerFacade` in the
roadmap §5.

## Lifecycle + tiers

`SessionLifecycle` (13 states) is a strict superset of the shipping `Readiness` type and
projects down to it; the injectable set stays exactly `{ready_checkpoint, ready_live}`.
Tiers 0–5 describe how completely an adapter realises the contract and are
**broker-derived and capped by handshake evidence** — never self-declared. See roadmap §4.

## Honesty invariants

- `platformCeilingTier` (what vendor surfaces could support) ≠ `awardedTier` (what XBus
  proves by running it). No Tier ≥ 2 award without a passing real-runtime R1–R4 log; no
  Tier ≥ 4 without a non-Bedrock `ready_live` proof; no Tier 5 without the conformance
  suite. Only Claude Code is validated today — at **Tier 3 / `ready_checkpoint` on Bedrock**.
- The **broker-side tier-cap** is the keystone control (roadmap §15 recommendation); build
  it in PR2 before any second-party adapter.
