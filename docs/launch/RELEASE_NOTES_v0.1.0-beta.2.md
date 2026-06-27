# XBus v0.1.0-beta.2 — Public Developer Preview

> **Pre-release · Public Developer Preview · NOT production-ready.**
> First public artifact. Same product behavior as the internally-hardened release
> candidate it was cut from — this release **freezes** that behavior and prepares
> the public distribution. Tag: `v0.1.0-beta.2` (semver pre-release).

XBus is a durable, local message bus that lets independently-launched
**Claude Code CLI sessions on one machine, under one OS user** discover each
other and exchange messages: session discovery, exact routing, acknowledgements,
correlated replies, an offline queue, and crash + broker-restart recovery — over
a custom secure transport (XBUS-STP) with a SQLite (WAL) durable store.

---

## What's in this release

### Identity / packaging
- Product version `0.1.0-beta.2`; exact build identity `xbus-0.1.0-beta.2-<commit>`
  (deterministic), kept **separate** from the stable wire **compatibility id**
  `xbus-p1-stp1-s5` (application protocol 1 · XBUS-STP 1 · schema 5). Builds
  interoperate iff the compatibility id matches.
- **Wire-compatible** with the prior internal candidate: no protocol or crypto
  change; XBUS-STP v1 test vectors are unchanged.
- Reproducible Windows artifact: per-file `SHA256SUMS`, a single manifest
  checksum, a CycloneDX SBOM, pinned pure-JS dependencies, and a normative
  artifact contract. **No build toolchain required at install time** (Node's
  `node:sqlite` built-in means no native addons).

### Included
- Durable **broker** (Node + `node:sqlite`/WAL): durable store, exact recipient
  resolution, offline queue, scheduling/controls, receipt/authority ledger, and
  the reliability reaper. Single instance enforced per data dir.
- **MCP tools** — `xbus_send`, `xbus_inbox`, `xbus_ack`, `xbus_reply`,
  `xbus_redeliver`, `xbus_sessions`, `xbus_register`, `xbus_status`.
- **Checkpoint hook** — delivers queued messages at the receiver's next lifecycle
  checkpoint (e.g. its next prompt).
- **`xbus` CLI + `xclaude` launcher**.
- **Reversible user-scope install/uninstall** with backup + rollback, a single
  canonical data root, and a transactional data-root migration on upgrade.
- **Body-free observability** surface (`xbus metrics` / `xbus doctor --json`).

### Delivery & correctness guarantees (what is actually enforced)
- **Durable-row dedup** — a `send` with the same idempotency key from the same
  sender does not create a second message row.
- **At-most-once context injection** — at most one model-visible request **body**
  on any normal recovery path; a recovery read returns metadata with
  `bodyIncluded:false`. Re-showing a body requires an explicit, audited
  `xbus_redeliver`.
- **Explicit readiness** — a session is never injected a request it cannot yet
  acknowledge; readiness is tracked separately from connection state and receive
  mode.
- **Reliability reaper** — ack-timeouts (→ retry / dead-letter), acceptance-TTL
  expiries, and abandoned leases are reclaimed, with a per-session fairness cap.

### Security
- **XBUS-STP** custom secure transport on every broker/client path: mutual
  installation-membership auth, per-frame AES-256-GCM (96-bit nonce, 128-bit tag)
  with per-connection HKDF-SHA256 keys, replay/reorder rejection, uniform
  auth-failure, and handshake-completion timeout (slow-loris bound). Resource-
  pressure hardened.
- Migration **downgrade guard**: old code refuses a database with a newer schema
  version; checksum drift fails closed.

### Performance (measured on a dev machine, over the encrypted transport)
- Handshake p95 **3.5 ms**, send round-trip p95 **3.4 ms**, inbox round-trip p95
  **5.7 ms**, sustained throughput **427 msg/sec** — all four objectives met with
  margin. Encryption is not the bottleneck. Reproduce with `npm run bench`. These
  are single-dev-machine numbers, not a benchmark suite across hardware.

---

## Honest limitations (read before relying on anything)

- **Public Developer Preview — not production-ready.**
- **Windows-first.** macOS and Linux are *implemented* (Unix socket + mode-based
  hardening) but **not yet runtime-validated**. Help wanted.
- **Same-machine, same-user only.** XBus defends against accidental cross-session
  access, unrelated OS users (where platform ACLs apply), and forged / replayed /
  reordered / tampered IPC frames. It is **not** a sandbox against malware running
  as your own fully-privileged user.
- **Cross-user Windows execution is not yet validated** (no second-account test
  environment was available).
- **Bedrock = deferred checkpoint delivery.** On Amazon Bedrock, Claude Code
  Channels are unavailable, so XBus delivers via a hook at the receiver's next
  lifecycle checkpoint. **Idle-wake is unsupported on Bedrock** — a fully idle
  session is not woken; it receives at its next activity. Automatic
  Stop-continuation is off by default.
- **At-most-once context presentation — NO exactly-once execution.** XBus
  guarantees the request *input* is presented to the model at most once on any
  normal path; it does **not** and cannot guarantee the model or the
  application's side effects run exactly once. Applications must key their own
  external writes on the stable `messageId` / `correlationId` XBus provides. See
  [docs/delivery-semantics.md](../delivery-semantics.md).
- **XBUS-STP is internally reviewed and adversarially tested, but NOT
  independently audited.** We are explicitly requesting external review of the
  protocol spec, key schedule, AAD construction, and the threat model.
- **No real signed installer yet.** The artifact is verifiable (checksums + SBOM);
  a code-signed installer is a release-time step still on the roadmap.

---

## Provenance & verification

- **Checksums:** verify the artifact against its `SHA256SUMS` (per-file) and the
  single artifact manifest checksum (`artifactManifestSha256`).
- **SBOM:** a CycloneDX SBOM ships with the artifact; dependencies are pinned and
  pure-JS.
- **Build identity (ADR 0011):** `xbus version` and `xbus doctor --json` report
  `productVersion`, exact `buildId`, `sourceCommit`, and `compatibilityId`;
  `doctor` additionally reports `installedArtifactManifestSha256`, the broker's
  exact build, and a `mixedBuilds` verdict (restart the broker if `true`).
- **Reproduce the verification:** `npm run verify:release` (build + verify) and
  `npm run bench -- --json`.

## Development & provenance note

Architecture, verification gates, and all release decisions were directed by the
creator/maintainer, **Aman Kumar**. AI agents were used extensively throughout —
for design, implementation, review, and testing — under that direction. This is
stated plainly because the security posture demands it: there has been **no
independent human security audit**, and none is implied by the internal
adversarial testing.

---

## Try it

- Quickstart (two sessions, send → checkpoint deliver → ack → correlated reply):
  [docs/quickstart.md](../quickstart.md)
- Isolated-profile trial (touches nothing real — set `XBUS_DATA_DIR` to a temp
  dir): [docs/installation.md](../installation.md)
- Requirements: Node.js **>=22.5**, Windows 10/11 for the validated path.

## Feedback we're explicitly asking for

1. XBUS-STP protocol spec, key schedule, and AAD construction.
2. The same-machine / same-user threat model and the no-forward-secrecy
   justification.
3. The Windows IPC decision (crypto boundary vs OS-ACL / .NET proxy — ADR 0010).
4. Is the delivery-semantics framing (at-most-once injection, not exactly-once
   execution) stated honestly and usefully?

Report security issues **privately** per
[SECURITY.md](https://github.com/Kumaraman110/XBus/blob/main/SECURITY.md), not as a
public issue.

---

*Full changelog: see [CHANGELOG.md](https://github.com/Kumaraman110/XBus/blob/main/CHANGELOG.md).*
*License: MIT.*
