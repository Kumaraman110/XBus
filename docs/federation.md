# XBus federation & enterprise — design sketch

> **EXPERIMENTAL / UNVALIDATED.** Everything in this document is a *future* design sketch.
> None of it is implemented, wired into the live broker, or tested. The shipping product is
> **same-machine, same-user** only (see the README non-goals). XBus opens **no** network
> listener and **no** relay. `src/federation/` contains compile-tested TypeScript **interfaces
> and a few pure helpers only** — `isFederationEnabled()` returns a hard `false`. Do not read
> any section below as a claim that cross-machine or enterprise operation works or was tested.

## Why write it down now

Beta.7 adds a private runtime, a real console, session controls, and managed execution — all
same-machine. Several of those have obvious multi-machine successors (an operator on one host
messaging a session on another; an enterprise fleet). Writing the *contracts* down now, as
typed interfaces mirroring the local primitives XBus already got right, keeps a future design
honest and reviewable without shipping any of it. Each interface below mirrors a proven local
concept.

## Device identity & pairing  *(mirrors the local root secret)*

`DeviceIdentity` = a stable device id + a PEM public key (the private key never leaves the
device). `PairingRequest` carries an **enrollment secret as a hash only** (`enrollmentSecretHash`),
never cleartext — exactly as the local root secret is create-if-absent, first-writer-wins,
ACL-hardened, hashed, and never logged. A future enrollment must not describe a weaker secret
handling than the local one.

## mTLS channel + end-to-end envelope  *(mirrors the local secure channel)*

Two distinct layers, on purpose:
- **`MtlsEnvelope`** — the transport-layer wrapper (mutual-TLS to the immediate peer/relay).
- **`E2EEnvelope`** — the application-layer sealed payload (iv/tag/ciphertext/aad), mirroring
  the local `SecureSession.seal` shape + AAD binding.

A relay that terminates mTLS still cannot read the `E2EEnvelope` — content is protected
end-to-end **through** any relay. This is the honest distinction between channel encryption and
end-to-end encryption.

## Outbound-only relay & proxy  *(no inbound listener, ever)*

`RelayEndpoint.direction` is the **literal type `'outbound-only'`** — an inbound-listener design
cannot even typecheck. This structurally preserves the same-machine safety posture: XBus never
opens a port; any future federation is a device dialing OUT to a relay it trusts, behind the
enterprise's `ProxyConfig` (http(s) proxy + no-proxy list + connect timeout).

## SSO / RBAC  *(mirrors the dashboard token + the capability matrix)*

`SsoPrincipal` = a short-lived, externally-issued principal (subject/issuer/tenant/roles/expiry)
— never a persisted cleartext credential, mirroring the in-memory, hashed, TTL'd dashboard tab
token. `RbacPolicy` is a **fail-closed allow-list** (`rbacAllows` denies any unlisted role/op),
mirroring the local `assertAllowed` capability matrix.

## Audit export  *(mirrors the hash-chained ledger)*

`AuditExport` is **body-free by type** (`bodyFree: true` literal) — ids/states/counts/hashes and
a `tipHash` only, exactly as the local ledger stores no bodies or secrets. No message content
ever leaves the machine in an export; a verifier re-checks the chain against `tipHash`.

## Tenant boundaries

`TenantBoundary` (`isolationLevel: 'strict'`) is the one concept with no local analog — a hard
partition between tenants' devices. Sketched now so a future multi-tenant deployment has a
typed boundary to enforce, not retrofit.

## What is explicitly NOT here

- No listener, relay server, socket, or networking of any kind.
- No wiring into the broker, IPC, or database (the module imports none of them).
- No `SCHEMA_VERSION` / wire-tuple change (pure types touch no migration, no wire).
- No claim of multi-machine or enterprise testing. When federation is actually built, it will
  be a separate, reviewed, tested milestone with its own ADRs — this sketch is the starting
  contract, nothing more.
