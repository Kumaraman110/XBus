# XBus

> **Public Developer Preview · Windows-first · same-machine, same-user**
> A durable local coordination layer for independent coding-agent sessions.

XBus is an independent, unofficial open-source project created and maintained by Aman Kumar. It is not affiliated with, endorsed by, sponsored by, or maintained by Anthropic.

XBus does not provide access to Claude, resell subscriptions, collect Claude credentials, or proxy user OAuth tokens. Users authenticate directly through their own supported Claude Code or cloud-provider environment.

XBus lets independently-launched Claude Code CLI sessions on **one computer, under one OS user** discover each other and exchange messages — with session discovery, exact routing, acknowledgements, correlated replies, an offline queue, and crash recovery across terminals. Claude and Claude Code are referenced only to describe the environments XBus supports, not as the product owner or brand.

```text
Terminal A (architect)                 Terminal B (implementer)
  xbus_send → "review the auth change"
                          ┌── durable broker (SQLite, WAL) ──┐
                          │  queued → checkpoint → injected   │
                          └───────────────────────────────────┘
                                         → arrives in B at its next prompt
                                         ← B acknowledges, then replies
  ← "looks good, one nit on token TTL"   (correlated reply)
```

## What it does (in one minute)

- **Discover** other Claude Code sessions by alias (`architect`, `project-a/backend`) or session id.
- **Send** a message to another session; it is **durably persisted** before send returns.
- **Deliver** at the receiver's next *checkpoint* (a normal prompt) — see the honest Bedrock note below.
- **Acknowledge** and **reply** with preserved correlation + causation.
- **Queue offline**: a disconnected recipient gets the message when it reconnects.
- **Survive restarts**: the broker can restart without losing queued messages.

## Honest limitations (read these)

- **Public Developer Preview** — not production-ready, not independently audited.
- **Windows-first.** macOS/Linux are implemented but **not yet runtime-validated** (clearly labeled; help wanted).
- **Bedrock = checkpoint delivery.** On Amazon Bedrock, Claude Code Channels are unavailable, so XBus delivers via a **hook at the receiver's next lifecycle checkpoint** (e.g. the next time its user submits a prompt). **Idle-wake is unsupported on Bedrock** — a fully idle session is not woken; it receives at its next activity. Automatic Stop-continuation is **off by default**.
- **Channel transport** is implemented first-class and contract-tested with a fake host; live Channel delivery is supported only on providers where Channels work (claude.ai / Console API key), labeled by provider.
- **Same-machine, same-user only.** XBus is same-user software. It protects against accidental cross-session access, unrelated OS users (where platform ACLs apply), and forged/replayed/tampered IPC — but it is **not** a sandbox against malware running as your own fully-privileged user.
- **Cross-user Windows execution is not yet validated** (no second-account test environment available).
- **Delivery guarantees:** durable persistence, exact recipient resolution, acknowledgements, correlated replies, offline queue, reconnect + broker-restart recovery, **at-most-once effective context injection** (where proven). **No exactly-once execution claim.**

## Security

The broker IPC runs over a Windows named pipe / Unix socket, treated as an **untrusted transport** and protected by **XBUS-STP** — a custom protocol (standard primitives: AES-256-GCM, HKDF-SHA256, HMAC) providing mutual installation-membership auth, per-frame confidentiality + integrity, and replay/reorder rejection. It is **internally reviewed and adversarially tested, not independently audited.** See [docs/security.md](docs/security.md) and [docs/secure-transport-spec.md](docs/secure-transport-spec.md). Report issues per [SECURITY.md](SECURITY.md).

## Install (developer preview)

> **Requires Node.js `>=22.13` and `<25`** (Node 25+ is not yet supported).
> Install is **PATH-free**: there is no global `xbus` command — you invoke the built
> entrypoint with `node`. Installation copies the plugin to a user-scope root and
> registers the MCP server + hook; it does **not** modify PATH, the registry, or a
> shell profile. Do **not** run `npm test` as an install step. See
> [docs/installation.md](docs/installation.md) for the full, reversible procedure.

```powershell
git clone https://github.com/Kumaraman110/XBus
cd XBus
npm install
npm run build
node .\dist\cli\main.js install --dry-run   # preview (writes nothing)
node .\dist\cli\main.js install             # user-scope install (no PATH change)
node .\dist\cli\main.js doctor              # verify health
node .\dist\launcher\xclaude.js             # launch Claude Code with XBus enabled
```

## Quick start

See [docs/quickstart.md](docs/quickstart.md) — launch two sessions from unrelated directories, register aliases, send, and watch the delivery state.

## Architecture

A per-user **broker** (Node + `node:sqlite`/WAL) owns the durable store and routing. Each Claude session runs an **MCP server** (the `xbus_*` tools) and a **checkpoint hook** (delivers at a prompt). Identity is layered: logical session → epoch → component instance, with capability-scoped authorization. See [docs/architecture.md](docs/architecture.md).

## Docs
- [Quickstart](docs/quickstart.md) · [Installation](docs/installation.md) · [Demo](docs/demo.md)
- [Architecture](docs/architecture.md) · [Delivery semantics](docs/delivery-semantics.md) · [Providers](docs/providers.md)
- [Security](docs/security.md) · [Privacy](docs/privacy.md) · [Troubleshooting](docs/troubleshooting.md)
- [Benchmarks](docs/benchmarks.md) · [Compatibility](docs/compatibility.md) · [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

## Status

Public Developer Preview. Same-machine, same-user, Windows-first, Bedrock checkpoint delivery. Custom secure protocol (XBUS-STP), internally reviewed, **not independently audited**. We are **requesting technical review** of the protocol spec, threat model, and Windows IPC decision — see [docs/roadmap.md](docs/roadmap.md).

## License
MIT — see [LICENSE](LICENSE).
