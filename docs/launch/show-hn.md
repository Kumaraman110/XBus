# Show HN draft

Norms applied (per news.ycombinator.com/showhn.html): title starts with
`Show HN: `; it links something people can run right now with no signup/email;
the body is first-person and explains how/why; limitations are stated plainly;
**no upvote/comment solicitation** (against HN rules). The maintainer must be
present in-thread to answer.

---

## Title (<= 80 chars)

```
Show HN: XBus – a local bus so independent Claude Code sessions can talk
```
(78 chars)

Alternates:
- `Show HN: A durable local message bus for independent Claude Code sessions`
- `Show HN: Let two Claude Code CLI sessions on one machine message each other`

## URL field

Link the repo directly (no signup, no email): `https://github.com/Kumaraman110/XBus`

---

## Text (the "Show HN" body / first comment)

I built XBus, a local message bus that lets independently-launched Claude
Code CLI sessions on one machine — under one OS user — discover each other and
exchange messages. Think of two terminals: an "architect" session and an
"implementer" session that can send each other a request, get an
acknowledgement, and get a correlated reply, instead of me copy-pasting between
windows.

Why I made it: I kept running several Claude Code sessions side by side on
different parts of a project and wanted them to coordinate without a cloud
service or me being the message router. So it's deliberately same-machine and
local-first — there's no network bus and no account.

How it works: a small per-user broker (Node + the new `node:sqlite` WAL store —
no native addons) owns a durable queue and routing. Each session runs an MCP
server exposing `xbus_*` tools (send / inbox / ack / reply / redeliver /
sessions / register). A send is durably persisted before it returns; the message
is delivered into the other session's context at its next lifecycle checkpoint
(its next prompt). The broker can crash and restart without losing queued
messages. The local IPC (a Windows named pipe / Unix socket) is treated as
untrusted and wrapped in a custom transport, XBUS-STP — mutual auth, per-frame
AES-256-GCM with per-connection HKDF keys, replay/reorder rejection.

Where I want to be honest, because this is an early Public Developer Preview, not
a finished product:

- It's Windows-first. macOS and Linux are implemented but I haven't been able to
  runtime-validate them yet — that's the #1 thing I'd love help with.
- Same-machine, same-user only. It defends against accidental cross-session
  access, other OS users (where ACLs apply), and forged/tampered IPC frames. It
  is NOT a sandbox against malware running as your own user.
- On Amazon Bedrock (a common Claude Code setup), the native idle-wake mechanism
  isn't available, so delivery is checkpoint-based: a fully idle session isn't
  woken — it gets the message at its next prompt. I surface that state honestly
  rather than pretending it was "delivered".
- The delivery guarantee is "the request body is shown to the receiving model at
  most once on any normal recovery path" — explicit, audited redelivery is the
  only way to re-show it. It is NOT exactly-once execution; I can't observe or
  fence what the model decides to do, so apps still need their own idempotency.
- XBUS-STP is internally reviewed and adversarially tested, but it has NOT had an
  independent security audit. I'd genuinely welcome eyes on the protocol spec,
  key schedule, and threat model.
- Provenance: I directed the architecture, the verification gates, and the
  release decisions. I used AI agents heavily for design, implementation, review
  and testing — I'd rather state that up front than imply a human-only audit that
  didn't happen.

You can try it without touching your real environment: there's an isolated-profile
trial (point `XBUS_DATA_DIR` at a temp dir, `xbus start` / `xbus doctor` /
`xbus stop`, delete the dir). Requires Node >=22.5. Repo, quickstart, the full
"honest limitations" list, the delivery-semantics doc, and the secure-transport
spec are all linked from the README.

Repo: https://github.com/Kumaraman110/XBus

Happy to answer anything — protocol design, the checkpoint-vs-idle-wake tradeoff,
why I went with a crypto boundary instead of trying to set a named-pipe ACL from
Node, or the dedup/readiness model. Feedback and pokes at the threat model are
the most useful thing right now.

---

### Reminders for posting
- Post during a weekday US-morning window for visibility; do not repost rapidly.
- Be in the thread to respond; HN rewards an engaged author on Show HN.
- Do NOT ask for upvotes or "check it out and star" — it violates HN guidelines.
- If asked "is this production-ready?" the honest answer is no — it's a preview.
