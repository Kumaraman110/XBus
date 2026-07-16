# AgenTel

> **The communications network for AI agents.**
> Public Developer Preview · Windows-first · same-machine, same-user.

AgenTel (formerly XBus) is an independent, unofficial open-source project created and
maintained by Aman Kumar. It is **not** affiliated with, endorsed by, sponsored by, or
maintained by Anthropic.

AgenTel does not provide access to Claude, resell subscriptions, collect Claude credentials,
or proxy user OAuth tokens. You authenticate directly through your own supported Claude Code
or cloud-provider environment. Claude and Claude Code are referenced only to describe the
environments AgenTel supports — not as the product owner or brand.

> **Renamed in beta.8 (was “XBus”).** The primary CLI is now `agentel`; `xbus` and `xclaude`
> remain deprecated-but-working aliases. Internal wire/on-disk identifiers keep their historic
> `XBus`/`XBUS-STP` names for compatibility — see [Rename & compatibility](#rename--compatibility).

## What AgenTel is

AgenTel lets independently-launched **Claude Code CLI sessions on one computer, under one OS
user** discover each other and exchange messages — with session discovery, exact routing,
acknowledgements, correlated replies, an offline queue, crash recovery across terminals, a
durable stable identity that survives session-id changes, and a live localhost dashboard.

```text
Terminal A (architect)                 Terminal B (implementer)
  agentel send → "review the auth change"
                          ┌── durable broker (SQLite, WAL) ──┐
                          │  queued → checkpoint → injected   │
                          └───────────────────────────────────┘
                                         → arrives in B at its next prompt
                                         ← B acknowledges, then replies
  ← "looks good, one nit on token TTL"   (correlated reply)
```

## The problem it solves

Two Claude Code sessions on the same machine can't talk to each other. You copy-paste between
terminals, lose track of who said what, and there is no durable record. AgenTel gives them a
**local message bus**: one session addresses another by a stable name, the message is durably
persisted before send returns, delivered at the recipient's next checkpoint, acknowledged, and
answered with a correlated reply — and it survives a broker restart or a recipient that is
offline when you send. Everything is visible in a read-only dashboard with a hash-chained audit
ledger.

## Current supported scope

- **Same-machine, same-user only.** One broker per OS user; sessions must run as the same user.
- **Windows-first.** macOS/Linux paths are implemented but **not yet runtime-validated**.
- **Delivery = checkpoint injection.** Messages arrive at the recipient's next lifecycle
  checkpoint (its next prompt). On Amazon Bedrock, idle-wake is unsupported (see limitations).
- **Provided:** durable persistence, exact recipient resolution, acknowledgements, correlated
  replies, offline queue, reconnect + broker-restart recovery, **durable stable identity across
  session-id changes** (new in beta.8), a live dashboard, and a hash-chained audit ledger.

## Architecture overview

A per-user **broker** (Node + `node:sqlite`/WAL) owns the durable store and routing. Each Claude
session runs an **MCP server** (the `xbus_*` tools) and a **checkpoint hook** (delivers at a
prompt). Identity is layered:

- **durable logical identity** — a stable id that owns the name + inbox, survives a Claude
  session-id change (fork/clear/compact/crash/resume);
- **generation / epoch** — a per-connection fencing token (a superseded epoch is rejected);
- **connection instance** — a live socket + component (mcp / hook / transport);
- **routable name + aliases** — owned by the logical identity, reclaimable with a broker-minted
  ownership secret.

See [docs/architecture.md](docs/architecture.md) and
[ADR 0027](docs/adr/0027-beta8-durable-logical-identity.md).

## Install & upgrade (developer preview)

> **Requires Node.js `>=22.13` and `<25`.** Install is **PATH-free**: there is no global
> `agentel` command on PATH — you invoke the built entrypoint with `node`. Installation copies
> the plugin to a user-scope root and registers the MCP server + hook; it does **not** modify
> PATH, the registry, or a shell profile. Do **not** run `npm test` as an install step. See
> [docs/installation.md](docs/installation.md) for the full, reversible procedure.

```powershell
git clone https://github.com/Kumaraman110/XBus
cd XBus
npm install
npm run build
node .\dist\cli\main.js install --dry-run   # preview (writes nothing)
node .\dist\cli\main.js install             # user-scope install (no PATH change)
node .\dist\cli\main.js doctor              # verify health (hooks, dashboard, ledger)
node .\dist\launcher\xclaude.js             # launch Claude Code with AgenTel enabled
```

**Upgrading from beta.7:** run `install` again with the beta.8 build. The schema migrates in
place (v9 → v10, additive); your SQLite contents — sessions, message/thread history, config,
auth, and the audit ledger — are preserved. Existing named sessions are backfilled into the new
name-ownership table (legacy-unprotected until they next opt into a secret).

## Your first agent-to-agent message

1. Launch two sessions from unrelated directories (`node .\dist\launcher\xclaude.js` in each).
   Each auto-registers and is offered a name derived from its workspace.
2. In session A: use the `xbus_send` tool → `to: "<session-B-name>", text: "review the auth change"`.
3. Session B receives it at its next prompt, calls `xbus_ack`, then `xbus_reply`.
4. Watch it live on the dashboard (opens automatically; re-open with
   `node .\dist\cli\main.js dashboard`).

See [docs/quickstart.md](docs/quickstart.md) for the full walkthrough.

## Dashboard & threads

Every session auto-registers at `SessionStart` and appears in an **authenticated localhost
dashboard** (opened automatically). It shows each session's lifecycle state, readiness, last
sent/received, and a per-session delivery breakdown, plus the operator ↔ session **thread**
console and audit-ledger health. The dashboard is **read-only by construction**, served under a
strict CSP, and gated by a one-time bearer nonce — no manual broker start, config edit, or token
handling.

Re-open or get the URL:

```powershell
node .\dist\cli\main.js dashboard            # open/focus the localhost dashboard
node .\dist\cli\main.js dashboard --no-open  # print the authenticated URL, don't open
```

## Delivery states

Each message rolls up to one of five user-facing states, shown as separate dashboard columns:

| State | Meaning |
|---|---|
| **Queued** | durably persisted, awaiting the recipient's next checkpoint |
| **Delivered** | written to the recipient's transport / injected at a checkpoint |
| **ACK** | the recipient acknowledged receipt |
| **Replied** | the recipient sent a correlated reply |
| **Failed** | undeliverable / dead-lettered / expired |

See [docs/delivery-semantics.md](docs/delivery-semantics.md).

## Stable identity & reconnect behavior (beta.8)

A session's **name and inbox belong to a durable logical identity**, not to the transient Claude
Code session id. When Claude Code presents a **new** session id for the same logical agent
(resume with a new id, `--fork-session`, `/clear`, `/compact`, or a crash-and-recreate), the
session can **reclaim** its name and its entire queued inbox automatically:

- at first name award the broker mints a **stable ownership secret**, persisted client-side in
  the ACL-protected data dir;
- on the next registration the successor presents it and is redirected onto the canonical
  identity — inheriting the name and all pending messages with **exactly-once** semantics
  preserved (nothing is re-sent by hand);
- a **live incumbent is never evicted** — if the original is still running, the newcomer is left
  unrouted (`pending`), exactly as before;
- a wrong or absent secret changes nothing (first-writer-wins, as in beta.7).

This is a **same-user continuity + accident-prevention** mechanism, not a defense against a
hostile same-user process (which can read the ACL-protected secret file anyway). See
[ADR 0027](docs/adr/0027-beta8-durable-logical-identity.md).

## Bundled runtime

The Windows artifact ships an AgenTel-owned `runtime/node.exe` (pinned inside the `[22.13,25)`
floor). An **installed** AgenTel launches the broker/CLI/hooks via the bundled runtime and
**ignores system Node/PATH** — you never install, select, or configure a Node version. Running
from a source checkout uses your system Node. See
[ADR 0022](docs/adr/0022-beta7-bundled-node-runtime.md).

## Security model

The broker IPC runs over a Windows named pipe / Unix socket, treated as an **untrusted
transport** and protected by **XBUS-STP** — a custom protocol (standard primitives: AES-256-GCM,
HKDF-SHA256, HMAC) providing mutual installation-membership auth, per-frame confidentiality +
integrity, and replay/reorder rejection. It is **internally reviewed and adversarially tested,
not independently audited.**

AgenTel is **same-user software**: it protects against accidental cross-session access, unrelated
OS users (where platform ACLs apply), and forged/replayed/tampered IPC — but it is **not** a
sandbox against malware running as your own fully-privileged user. The durable-identity ownership
secret lives in the ACL-protected data dir; it prevents *accidental* reclaim and gives a
legitimate successor continuity, and is **never** written to the audit ledger or logs (only its
hash is stored). See [docs/security.md](docs/security.md) and
[docs/secure-transport-spec.md](docs/secure-transport-spec.md); report issues per
[SECURITY.md](SECURITY.md).

## Troubleshooting & doctor

```powershell
node .\dist\cli\main.js doctor   # checks the SessionStart hook, MCP wiring, bundled runtime,
                                 # dashboard, and audit-ledger health; prints an actionable report
```

See [docs/troubleshooting.md](docs/troubleshooting.md).

## Honest limitations (read these)

- **Public Developer Preview** — not production-ready, not independently audited. No production,
  enterprise, or SLA claims.
- **Windows-first.** macOS/Linux are implemented but **not yet runtime-validated**.
- **Bedrock = checkpoint delivery.** On Amazon Bedrock, Claude Code Channels are unavailable, so
  AgenTel delivers via a **hook at the receiver's next lifecycle checkpoint**. **Idle-wake is
  unsupported on Bedrock** — a fully idle session is not woken; it receives at its next activity.
  Automatic Stop-continuation is **off by default**.
- **Same-machine, same-user only.** Cross-user Windows execution is **not yet validated**.
- **Delivery guarantees:** durable persistence, exact recipient resolution, acknowledgements,
  correlated replies, offline queue, reconnect + broker-restart recovery, durable stable identity,
  and **at-most-once effective context injection** (where proven). **No exactly-once *execution*
  claim** (exactly-once applies to ack/reply/injection bookkeeping, not to what a model chooses to
  do with a message).
- **`/clear` and `/compact` session-id behavior is undocumented upstream.** AgenTel's durable
  identity is designed to reclaim across a session-id change regardless, and this is verified on
  the real artifact — but the exact upstream behavior is not something AgenTel controls.

## Experimental / default-off capabilities

- **Managed background execution / `managed_spawn` scheduling** (ADR 0025): experimental and
  **off by default**. Schedules default to `enqueue_only` (a durable queued message that drains
  at the target's next checkpoint).
- **Automatic Stop-continuation** (idle-wake): off by default; unsupported on Bedrock.

## Federation & enterprise

The federation interfaces are an **experimental design sketch — not implemented, not wired, not
tested.** There is **no** live federation, cross-machine transport, or enterprise validation.
See [docs/federation.md](docs/federation.md), clearly marked as a design sketch.

## Rename & compatibility

beta.8 renamed the product XBus → **AgenTel**. What changed and what is deliberately preserved:

| Renamed (user-facing) | Preserved (compatibility) |
|---|---|
| Product/brand, dashboard, CLI help, banners | Wire tuple `xbus-p1-stp1-s10`, `XBUS-STP` protocol |
| Primary CLI `agentel`, launcher `agenclaude` | Deprecated aliases `xbus` / `xclaude` (≥2 releases) |
| Config env `AGENTEL_*` (primary) | Legacy `XBUS_*` still read as a fallback |
| — | On-disk layout (data dir, `xbus.sqlite`, owner tag) |
| — | `xbus_*` MCP tool names; `XBUS_*` protocol error codes |

Your data, config, auth, and history carry over untouched. The GitHub repository is renamed only
after regression acceptance; clone/redirect compatibility is preserved where GitHub supports it.

## Docs

- [Quickstart](docs/quickstart.md) · [Installation](docs/installation.md) · [Demo](docs/demo.md)
- [Architecture](docs/architecture.md) · [Durable identity (ADR 0027)](docs/adr/0027-beta8-durable-logical-identity.md) · [Delivery semantics](docs/delivery-semantics.md) · [Providers](docs/providers.md)
- [Security](docs/security.md) · [Privacy](docs/privacy.md) · [Troubleshooting](docs/troubleshooting.md)
- [Benchmarks](docs/benchmarks.md) · [Compatibility](docs/compatibility.md) · [Roadmap](docs/roadmap.md)
- [Federation & enterprise](docs/federation.md) *(experimental design sketch — not implemented, not tested)*
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

## Contributing & release verification

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

**Verify from a fresh clone — one command, nothing preinstalled** (Windows-first). With only an
unsupported Node (e.g. Node 25) on PATH and no build yet:

```powershell
node scripts/agentel.mjs verify
```

The committed bootstrap (`scripts/agentel.mjs`, Node built-ins only) provisions a COMPLETE approved
Node 22/24 runtime into `.agentel/node` — using an existing approved Node or `AGENTEL_VERIFY_NODE`
if present, else downloading the **pinned** official Node ZIP into `.agentel/cache` and verifying it
against a committed SHA-256 before extracting — then runs `npm ci`, builds, and runs the full
`agentel verify` gate under it. No admin / NVM / PATH edit / manual download; offline once cached;
concurrency-safe; recovers from interrupted downloads/extractions; fails closed with exact
proxy/TLS remediation. Everything it writes lives under the gitignored `.agentel/`.

If you already have an approved Node 22/24 + a built `dist/`, the underlying steps are also runnable
directly:

```powershell
npm run build && npm test          # full unit + integration + security suite
npm run verify:release             # reproducible-artifact + content-scan checks (run twice)
node .\dist\cli\main.js verify     # the one-command gate (resolve runtime → gate → acceptance)
node .\dist\cli\main.js doctor     # green on a clean install
npm audit                          # zero high/critical
```

## Status

Public Developer Preview. Same-machine, same-user, Windows-first, Bedrock checkpoint delivery.
Custom secure protocol (XBUS-STP), internally reviewed, **not independently audited**. We are
**requesting technical review** of the protocol spec, threat model, and Windows IPC decision —
see [docs/roadmap.md](docs/roadmap.md).

## License
MIT — see [LICENSE](LICENSE).
