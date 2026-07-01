# Compatibility

## Runtime

| Requirement | Value |
|-------------|-------|
| Node.js | `>=22.5` (uses the `node:sqlite` built-in) |
| Native addons | None (pure-JS deps only) |
| Build toolchain at runtime | Not required |

## Platforms

| Platform | Status |
|----------|--------|
| Windows 10/11 (same user) | **Primary, validated.** ACL hardening via `icacls`; named-pipe IPC wrapped by XBUS-STP. |
| Windows (cross user) | **Not yet runtime-validated** (no second-account environment). Treat as unverified. |
| macOS | Implemented (Unix socket + mode hardening), **not yet runtime-validated**. |
| Linux | Implemented (Unix socket + mode hardening), **not yet runtime-validated**. |

## Providers

| Provider | Delivery | Notes |
|----------|----------|-------|
| Amazon Bedrock | `hook_checkpoint` | Validated. No idle-wake; Stop-continuation off by default. |
| claude.ai / Console API key | Channel (where enabled) or `hook_checkpoint` | Live Channel delivery only where Channels work. |

See [providers.md](providers.md) for the delivery-mode detail.

## Versioning

- **Schema version** — migrations are version + checksum tracked. Forward
  migrations apply automatically; checksum drift and a newer-than-code database
  both fail closed (see [installation.md](installation.md), §8).
- **Protocol version** — broker and client run a compatibility handshake (ADR
  0004) before registration; incompatible clients get a typed verdict and are not
  allowed to register against an incompatible broker.
- **Build identity (ADR 0011)** — separates two concepts that were previously
  conflated under one `buildId`:
  - **compatibilityId** — `xbus-p<protocol>-stp<stp>-s<schema>` (currently `xbus-p1-stp1-s6`,
    moved from `-s5` by the beta.4 schema migration v6, ADR 0012 §3).
    The STABLE, **version-independent** interop tuple; builds interoperate iff this
    matches. This is the value the XBUS-STP wire field named `buildId` carries.
  - **buildId (exact)** — `xbus-<version>-<shortCommit>`. Deterministically identifies
    the **exact source build**; diagnostics only, never on the wire.
  - **sourceCommit** — the full git commit SHA the artifact was built from.
  - **artifactManifestSha256** — sha256 of the artifact's `SHA256SUMS`; the exact
    distributable identity, recorded at install time.

  `xbus version` and `xbus doctor --json` report all of these
  (`productVersion`, `buildId`, `sourceCommit`, `compatibilityId`), and `doctor`
  additionally reports `installedArtifactManifestSha256`, the broker's exact build
  (`brokerExactBuild`), and a `mixedBuilds` verdict.

## Stability

Pre-1.0 Developer Preview. The MCP tool surface, frame protocol, and schema may
change between preview releases; the [CHANGELOG](../CHANGELOG.md) records breaking
changes. Pinning a specific build is recommended until 1.0.
