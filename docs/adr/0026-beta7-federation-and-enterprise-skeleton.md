# ADR 0026 — Beta.7: federation & enterprise skeleton (interfaces + docs only)

**Status:** EXPERIMENTAL — Unvalidated, NOT implemented, NOT tested · **Date:** 2026-07-14 ·
beta.7 · mirrors ADR 0002 (root secret), the local secure channel, dashboard auth, and the
hash-chained ledger. Depends on / changes NOTHING in the live broker.

## Context

Beta.7 delivers same-machine adoption/control/execution. The goal asks for a *future*
LAN/relay/enterprise **skeleton** — "compile-tested interfaces and honest docs" for device
identity, pairing, mTLS/E2E envelopes, outbound relay, SSO/RBAC, proxies, audit export, and
tenant boundaries — explicitly **NOT** claiming it was tested, with **no production listener or
relay**, marked experimental and unvalidated.

## Decision

1. **Interfaces + a few pure helpers ONLY, in a self-contained `src/federation/` module.**
   Pure TypeScript compiled by `tsc` under the same strict flags (`strict`,
   `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) as the rest of `src/`. It imports
   **nothing** from `src/broker`, `src/ipc`, or `src/database`, so it can never pull the live
   broker / node:sqlite / socket code into a "pure" module. Types are string/number/base64,
   never `Buffer`/DB types.

2. **Each interface mirrors a proven LOCAL primitive** (so the future design inherits the
   properties XBus already got right): `DeviceIdentity`/`PairingRequest` ← the root secret
   (hashed, TTL'd, never cleartext); `MtlsEnvelope`/`E2EEnvelope` ← the secure channel
   (channel vs end-to-end, distinct on purpose); `RelayEndpoint`/`ProxyConfig` ← outbound-only
   posture; `SsoPrincipal`/`RbacPolicy` ← dashboard auth + the fail-closed capability matrix;
   `AuditExport` ← the body-free hash-chained ledger; `TenantBoundary` ← a new concept.

3. **Structural safety by type.** `RelayEndpoint.direction` is the literal `'outbound-only'`
   (an inbound-listener design cannot typecheck) and `AuditExport.bodyFree` is the literal
   `true` (an export carrying message content cannot typecheck). The RBAC helper is
   fail-closed (unknown role / unlisted op → denied), mirroring `assertAllowed`.

4. **A honesty tripwire.** `isFederationEnabled()` returns a hard `false` (not a config read),
   and `FEDERATION_STATUS === 'experimental-unvalidated'`. The shard test asserts both, so a
   future contributor cannot silently flip federation on without design review.

5. **A SEPARATE experimental error taxonomy.** `FederationErrorCode` is its own enum in
   `src/federation/errors.ts`; the live `XBusErrorCode` (`src/protocol/errors.ts`) is NOT
   extended — a new live wire error code would imply a wire surface federation doesn't have.

6. **Docs, not code paths.** `docs/federation.md` is the honest narrative (every section
   prefixed EXPERIMENTAL/UNVALIDATED); the README links it with an explicit
   "(experimental design sketch — not implemented)" label. `SCHEMA_VERSION` and the wire tuple
   are unchanged (pure types, no migration, no wire).

7. **Test placement.** `tests/unit/federation-interfaces.test.ts` lives under the existing
   `unit` shard so `shardCoverage()` stays exhaustive (no `SHARDS` change). It constructs one
   literal per interface (compile proof) + exercises the helpers (behavior proof); it spawns
   nothing, opens nothing, and reads no DB.

## Consequences

- Positive: a reviewable, typed starting contract for a future federation milestone, inheriting
  XBus's proven local security properties, with structural guardrails (outbound-only, body-free,
  fail-closed) and a tripwire against premature enablement.
- Negative / accepted: dead code until a real federation milestone consumes it — kept minimal
  and honestly labeled so it can't be mistaken for a shipped capability.
- Nothing here is validated for multi-machine or enterprise use. That is a future, separately
  ADR'd, separately tested milestone.
