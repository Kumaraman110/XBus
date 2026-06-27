<!--
  ============================================================================
  DRAFT — NOT PUBLISHED
  This is a draft of the GitHub Release body for XBus v0.1.0-beta.2.
  It has NOT been published and MUST NOT be published as-is.
  Before publishing: fill every [FILL AT PUBLISH] placeholder (checksum/SBOM
  links, tag/commit, asset URLs) and re-verify the benchmark numbers against
  the run that ships with the artifact.
  ============================================================================
-->

# XBus v0.1.0-beta.2 — first public Developer Preview

> **DRAFT — NOT PUBLISHED.** This document is a draft of the GitHub Release notes.
> It is not a published release. All `[FILL AT PUBLISH]` placeholders must be
> completed and the artifact links verified before this is cut as a real release.

> **Public Developer Preview · Windows-first · same-machine, same-user.**
> Not production-ready. Read [Known limitations](#known-limitations) before you rely on anything here.

A durable local message bus that lets **independently-launched Claude Code CLI
sessions on one machine, under one OS user**, discover each other and exchange
messages — across separate terminals.

- Repository: https://github.com/Kumaraman110/XBus
- Tag: `v0.1.0-beta.2` · Commit: `[FILL AT PUBLISH: source commit SHA]`
- License: MIT

---

## The problem it solves

You open two Claude Code sessions in two terminals — say an "architect" working
in one project and an "implementer" in another. Today those sessions are blind to
each other. There is no built-in way for one to hand work to the other, ask a
question, or receive a correlated answer; you end up copy-pasting between windows
and acting as the message bus yourself.

XBus is that message bus. A per-user broker gives independent sessions:

- **Discovery** — find other sessions by alias (`architect`, `project-a/backend`) or session id.
- **Durable send** — a message is persisted to a local SQLite store *before* `send` returns.
- **Checkpoint delivery** — the message arrives in the recipient at its next lifecycle checkpoint (a normal prompt).
- **Acknowledge + correlated reply** — replies carry `correlationId` + `causationId` back to the original request.
- **Offline queue** — a disconnected recipient gets the message when it reconnects.
- **Crash recovery** — the broker can restart without losing queued messages.

---

## Working demo (two sessions exchanging a message)

> Preview note: a real install modifies user-scope config and is gated behind
> explicit approval — see [Installation](#installation) and
> [docs/installation.md](../installation.md). The flow below is the intended,
> tested-in-isolation experience once installed.

**1. Start the broker (once per machine/user)** — it also auto-starts on first use:

```powershell
xbus start
xbus doctor      # verify: data dir, broker reachable, secure transport on
```

**2. Launch two sessions, from two unrelated project directories:**

```powershell
# terminal A
xclaude          # launches Claude Code with XBus enabled

# terminal B
xclaude
```

**3. Register an alias in each session:**

```
A: xbus_register { "alias": "architect" }
B: xbus_register { "alias": "implementer" }
```

```
xbus sessions
Alias        Project   Connection  Receive mode     Readiness         Queued  Unacked
architect    proj-a    connected   hook_checkpoint  ready_checkpoint  0       0
implementer  proj-b    connected   hook_checkpoint  ready_checkpoint  0       0
```

**4. Send from A — durably persisted before the call returns:**

```
A: xbus_send { "to": "implementer", "text": "Please review the auth change in PR #42.",
               "requiresAck": true, "requiresReply": true }
→ state: queued_until_checkpoint
```

**5. B receives it at its next checkpoint (or reads on demand), acks, and replies:**

```
B: xbus_inbox
→ one message, body shown ONCE, with an injection_id

B: xbus_ack   { "messageId": "...", "status": "accepted", "injectionId": "..." }
B: xbus_reply { "messageId": "...", "text": "LGTM, one nit on token TTL.",
                "outcome": "completed", "injectionId": "..." }
```

**6. A receives the correlated reply:**

```
A: xbus_inbox
→ kind: reply, correlationId + causationId tie it back to the original request
```

Prefer a scripted, reproducible run? The dogfood end-to-end scenario has two
sessions detect breaking changes between two OpenAPI contracts over the encrypted
transport:

```
npx vitest run tests/e2e/dogfood-contract-review.test.ts
```

---

## Supported environment

| | |
|---|---|
| **Node.js** | `>=22.5` (uses the `node:sqlite` built-in — **no native addons**, no C/C++ toolchain) |
| **Windows 10/11, same user** | **Primary, validated.** ACL hardening via `icacls`; named-pipe IPC wrapped by XBUS-STP. |
| **Windows, cross user** | Implemented, **not yet runtime-validated** (no second-account environment). Treat as unverified. |
| **macOS** | Implemented (Unix socket + mode hardening), **not yet runtime-validated**. |
| **Linux** | Implemented (Unix socket + mode hardening), **not yet runtime-validated**. |
| **Amazon Bedrock** | Delivery via `hook_checkpoint`. **No idle-wake**; automatic Stop-continuation off by default. |
| **claude.ai / Console API key** | Live Channel delivery where Channels are available, else `hook_checkpoint`. |

---

## Installation

> A real install modifies user-scope configuration (PATH, the Claude Code MCP +
> hook registration, and a per-user data directory). This preview's automated work
> does **not** perform that real install — those steps are gated behind explicit
> approval. The procedure below is the intended, reversible flow, fully exercisable
> against a throwaway profile first. See [docs/installation.md](../installation.md).

**Try it in an isolated profile first (no real changes):**

```powershell
$env:XBUS_DATA_DIR = "$env:TEMP\xbus-trial"   # your real ~/.claude/xbus is untouched
xbus start
xbus doctor
xbus stop
Remove-Item -Recurse -Force $env:TEMP\xbus-trial   # full uninstall of the trial
```

**Build from source:**

```
git clone https://github.com/Kumaraman110/XBus
cd XBus
npm install
npm run build
npm test            # optional: full suite
```

**Install at user scope, then launch Claude with XBus enabled:**

```powershell
xbus install
xclaude
```

A self-contained, checksummed, SBOM'd Windows package can be assembled with
`npm run package:win` (see [docs/packaging.md](../packaging.md)). No code-signed
installer ships in this preview.

---

## Verifying the artifact

This release ships integrity and provenance metadata alongside the package:

- **`SHA256SUMS`** — SHA-256 of every shipped file; `[FILL AT PUBLISH: link to SHA256SUMS asset]`
- **CycloneDX SBOM (`sbom.json`)** — name + version + purl + license for the shipped dependency set; `[FILL AT PUBLISH: link to sbom.json asset]`
- **Artifact manifest checksum** — `artifactManifestSha256`, recorded at install time and reported by `xbus doctor --json`; `[FILL AT PUBLISH: value]`

Build identity (ADR 0011): product version `0.1.0-beta.2`, exact build id
`xbus-0.1.0-beta.2-<commit>`, and the stable wire **compatibility id**
`xbus-p1-stp1-s5` (application protocol 1 · XBUS-STP 1 · schema 5). This build is
wire-compatible with the prior internal candidate — no protocol or crypto change;
the XBUS-STP v1 test vectors are unchanged.

---

## Benchmarks

XBus is a local, same-machine bus; the performance goal is "imperceptible to an
interactive session", not network throughput. All numbers are measured over the
**encrypted** transport (XBUS-STP).

**Indicative dev-host numbers (single developer machine — not a spec or an SLA):**

| Metric | Indicative result |
|--------|-------------------|
| Handshake (connect + full mutual auth), p95 | **~3.5 ms** |
| Send round-trip (encrypted), p95 | **~3.4 ms** |
| Sustained send throughput, single client | **~427 msg/s** |

These are illustrative measurements from one machine and will vary with hardware,
OS, and Node version. They are well inside the project's targets (handshake p95
< 150 ms, send round-trip p95 < 50 ms, throughput > 200 msg/s) — encryption is not
the bottleneck. Reproduce on your own machine and read the full methodology, the
regression guard, and the honest non-claims in
[docs/benchmarks.md](../benchmarks.md):

```
npm run build && npm run bench          # human-readable
npm run bench -- --json                 # machine-readable
```

---

## Known limitations

Read these before relying on anything. We label limitations explicitly and would
rather understate than overstate.

- **Public Developer Preview — not production-ready.** APIs, the MCP tool surface,
  the frame protocol, and the schema may change between preview releases.
- **Windows-first.** macOS and Linux are implemented but **not yet
  runtime-validated** (help wanted).
- **Same-machine, same-user only.** XBus protects against accidental cross-session
  access, unrelated OS users (where platform ACLs apply), and forged/replayed/
  tampered IPC. It is **NOT a sandbox** against malware running as your own
  fully-privileged user.
- **Cross-user Windows execution is not yet validated** (no second-account test
  environment). Treat it as unverified.
- **Bedrock = deferred checkpoint delivery.** On Amazon Bedrock, Channels are
  unavailable, so XBus delivers via a hook at the receiver's next lifecycle
  checkpoint. **Idle-wake is unsupported on Bedrock** — a fully idle session is not
  woken; it receives at its next activity. Automatic Stop-continuation is off by
  default.
- **At-most-once context presentation — NO exactly-once execution.** XBus
  guarantees one durable row, at most one effective context injection per
  epoch+logical-number, and at most one model-visible body on any normal path. It
  does **not** guarantee the model or the application's side effects run exactly
  once — that requires application-level idempotency keyed on the stable
  identifiers XBus provides. See [docs/delivery-semantics.md](../delivery-semantics.md).
- **XBUS-STP is internally reviewed and adversarially tested, but NOT
  independently audited.** No external security audit has been performed. We are
  actively requesting external review.

### How this was built (in the spirit of honesty)

XBus was created and is maintained by **Aman Kumar**, who directed the
architecture, the verification gates, and the release decisions. **AI agents were
used extensively** throughout design, implementation, review, and testing. To be
explicit: there has been **no independent human security audit** of XBUS-STP or
the threat model — internal review and adversarial testing are not a substitute
for one, and an external audit is on the roadmap.

---

## Security

The broker IPC runs over a Windows named pipe / Unix domain socket, treated as an
**untrusted transport** and protected by **XBUS-STP** — a custom protocol built
from standard primitives (AES-256-GCM, HKDF-SHA256, HMAC) providing mutual
installation-membership auth, per-frame confidentiality + integrity, and
replay/reorder rejection. There is **no forward secrecy**, which is justified
against the same-user threat model (an attacker who can read the per-installation
root secret already has your privileges).

We are specifically requesting review of: the XBUS-STP spec + key schedule + AAD
construction; the same-user threat model and the no-forward-secrecy justification;
the Windows IPC decision (crypto boundary vs OS ACL / .NET proxy); and the
connection-bound, non-bearer authority model. Please report vulnerabilities
privately per [SECURITY.md](../../SECURITY.md) — not as a public issue.

---

## Learn more

- **Architecture** — components, identity model, delivery path: [docs/architecture.md](../architecture.md)
- **Security** — threat model + XBUS-STP: [docs/security.md](../security.md)
- **Benchmarks** — methodology + regression guard: [docs/benchmarks.md](../benchmarks.md)
- Delivery semantics: [docs/delivery-semantics.md](../delivery-semantics.md) · Compatibility: [docs/compatibility.md](../compatibility.md) · Roadmap: [docs/roadmap.md](../roadmap.md)

---

## Contributing

This is a preview and contributions are genuinely welcome — especially in the gaps
above:

- **macOS / Linux runtime validation** — run the suite on a real machine and report results.
- **Cross-user Windows validation** — exercise the cross-account boundary.
- **External review of XBUS-STP** — protocol and threat-model review.
- **Provider coverage** — live Channel delivery beyond Bedrock checkpoint mode.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) and the [Code of Conduct](../../CODE_OF_CONDUCT.md).
Open an issue or a focused PR (branch from `main`, one concern per PR, `npm run build`
and `npm test` green). Honesty over optimism: PRs that overstate a guarantee the
code doesn't enforce will be asked to soften.

---

**Full changelog:** [CHANGELOG.md](../../CHANGELOG.md) ·
Compare: `[FILL AT PUBLISH: e.g. https://github.com/Kumaraman110/XBus/commits/v0.1.0-beta.2]`

<!-- DRAFT — NOT PUBLISHED. Complete all [FILL AT PUBLISH] placeholders before cutting the release. -->
