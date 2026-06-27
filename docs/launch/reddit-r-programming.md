# r/programming launch post draft

Norms applied: plain descriptive title (no clickbait, no emoji); the submission
links the repo; the **first comment** carries context + limitations + the
specific feedback asks; self-promotion kept low-key and honest. Check the
subreddit's current self-promotion / "Saturday" rules before posting; some
programming subs restrict project self-posts.

---

## Title (plain, descriptive)

```
XBus: a durable local message bus for independent Claude Code CLI sessions (Public Developer Preview)
```

Alternate:
```
I built a local, same-machine message bus so independent Claude Code sessions can coordinate (open source, preview)
```

## Link

`https://github.com/Kumaraman110/XBus`

---

## First comment (context + limitations + asks)

Author here. XBus is a small open-source (MIT) message bus that lets
independently-launched Claude Code CLI sessions on **one machine, under one OS
user** discover each other and exchange messages — send, acknowledge, and get a
correlated reply between, say, an "architect" terminal and an "implementer"
terminal, instead of hand-relaying between windows.

The design in one paragraph: a per-user broker (Node + the `node:sqlite` WAL
store, so no native addons) owns a durable queue and exact routing. Each session
runs an MCP server exposing `xbus_*` tools and a checkpoint hook. A send is
durably persisted before it returns; delivery lands in the other session's
context at its next lifecycle checkpoint; the broker survives crashes/restarts
without losing queued messages. The local IPC (named pipe / Unix socket) is
treated as untrusted and wrapped in a custom transport (XBUS-STP): mutual auth,
per-frame AES-256-GCM with per-connection HKDF keys, replay/reorder rejection.

Deliberately honest about what this is and isn't — it's an early **Public
Developer Preview**, not production software:

- **Windows-first.** macOS/Linux are implemented but not yet runtime-validated.
- **Same-machine, same-user only.** Not a cross-machine bus, and **not** a
  sandbox against malware running as your own user.
- **Bedrock = checkpoint delivery.** Idle-wake isn't available on Bedrock, so an
  idle session receives at its next prompt; the sender is told that honestly.
- **At-most-once context presentation, NOT exactly-once execution.** The request
  body is shown to the model at most once on any normal path (explicit, audited
  redelivery aside); apps still need their own idempotency for side effects.
- **XBUS-STP is internally reviewed and adversarially tested, not independently
  audited.**
- **Provenance:** I directed the architecture, verification gates and release
  decisions; AI agents were used extensively for design/impl/review/testing.
  Stating that rather than implying a human-only audit.

Feedback I'm specifically looking for:
1. The XBUS-STP protocol spec / key schedule / AAD — anyone who does protocol
   review, I'd love the scrutiny.
2. Whether the same-user threat model + no-forward-secrecy justification holds up.
3. The Windows IPC call: a crypto boundary in pure Node vs depending on an
   OS-ACL / .NET proxy for the named pipe.
4. Is the delivery-semantics framing (at-most-once injection, not exactly-once
   execution) stated honestly and usefully, or is it confusing?

The README has a full "honest limitations" section, and there's an
isolated-profile way to try it without touching your real setup (Node >=22.5).
Security issues: please use the private policy in the repo, not a public comment.

Not looking for stars — looking for someone to poke holes in the protocol and to
run it on macOS/Linux and tell me what breaks.
