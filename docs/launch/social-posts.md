# Launch posts — XBus v0.1.0-beta.2

> **STATUS: DRAFT — NOT PUBLISHED.** These are draft launch posts for review only.
> Nothing here has been posted to any platform. Do not publish without a final
> human sign-off pass on every honesty claim below.

**Subject:** XBus v0.1.0-beta.2 — a local message bus that lets independent
Claude Code CLI sessions on one machine coordinate.

**Repo:** https://github.com/Kumaraman110/XBus

**Standing honesty constraints (apply to every post):**
- It is a **Public Developer Preview**, not production-ready.
- It is **Windows-first**: macOS/Linux are implemented but **not yet runtime-validated**.
- It is **same-machine, same-user only** — not a sandbox against malware running as your own user.
- The custom transport (XBUS-STP) is **internally reviewed and adversarially tested, NOT independently audited.**
- On **Amazon Bedrock**, delivery is a deferred hook at the receiver's next checkpoint; **idle-wake is unsupported on Bedrock.**
- The guarantee is **at-most-once context presentation**, **not** exactly-once execution.
- AI agents were used extensively for design, implementation, review, and testing — state this plainly; never imply an independent human security audit.

---

## 1. Hacker News (Show HN)

**Title** (keep it plain, no hype — per the Show HN guidelines):

```
Show HN: XBus – a local message bus so separate Claude Code sessions can talk
```

**Body** (one paragraph):

> I kept running two or three Claude Code sessions in separate terminals — an
> "architect" in one project, an "implementer" in another — and they had no way to
> talk to each other. XBus is my attempt at fixing that: a per-user, same-machine
> message bus where independently launched Claude Code CLI sessions discover each
> other by alias, send messages, acknowledge, and get correlated replies, with a
> durable SQLite-backed broker that survives crashes and restarts. The local IPC
> (named pipe / Unix socket) is treated as untrusted and wrapped in a custom
> transport (XBUS-STP: mutual auth, per-frame AES-256-GCM, replay/reorder
> rejection). Honest status: it's a Public Developer Preview, not production-ready,
> Windows-first (macOS/Linux are implemented but not yet runtime-validated), and
> same-machine/same-user only — it is not a sandbox against malware running as your
> own user. On Bedrock, delivery is a deferred hook at the receiver's next prompt
> (no idle-wake), and the guarantee is at-most-once context presentation, not
> exactly-once execution. The transport has been internally reviewed and
> adversarially tested but **not** independently audited — I'd genuinely value eyes
> on the protocol spec and threat model. AI agents were used heavily throughout
> design, implementation, and testing; I directed the architecture, the
> verification gates, and the release. Repo, docs, and the full "what it does NOT
> guarantee" writeups: https://github.com/Kumaraman110/XBus

**First comment (optional, by author — context HN readers appreciate):**

> Author here. The two design decisions I'd most like critique on: (1) wrapping the
> local pipe/socket in crypto (XBUS-STP) instead of relying on OS ACLs — on Windows
> a named pipe's DACL isn't settable from Node's `net` API, so I put the boundary in
> pure Node; is that the right call, or am I reinventing something? (2) the delivery
> framing — I deliberately do not claim exactly-once execution, only at-most-once
> context presentation on any normal recovery path, with explicit, audited
> redelivery as the only way to re-show a body. Delivery-semantics and security docs
> are linked from the README. Happy to be told where this is wrong.

---

## 2. Reddit

### 2a. r/programming

**Title:**

```
XBus – a durable local message bus so independent CLI agent sessions on one machine can coordinate (Developer Preview, Windows-first, MIT)
```

**Body:**

> If you run more than one AI coding CLI session at once, you've probably hit this:
> the sessions are completely isolated. There's no built-in way for one to hand work
> to another or get an answer back. XBus is a small attempt at the coordination
> problem — a per-user, same-machine message bus.
>
> What it actually does:
> - Sessions discover each other by alias or session id.
> - You send a message to another session; it's durably persisted (SQLite/WAL)
>   before send returns.
> - Delivery happens at the receiver's next lifecycle checkpoint; the receiver
>   acknowledges and can send a correlated reply.
> - Offline queue + crash/reconnect/broker-restart recovery.
> - The local IPC (named pipe / Unix socket) is treated as untrusted and wrapped in
>   a custom transport (XBUS-STP): mutual auth, per-frame AES-256-GCM, replay/reorder
>   rejection.
>
> Where it's honestly limited (please read before judging):
> - **Public Developer Preview**, not production-ready.
> - **Windows-first.** macOS/Linux are implemented but not yet runtime-validated.
> - **Same-machine, same-user only.** It is not a sandbox against malware running as
>   your own user.
> - The transport is **internally reviewed and adversarially tested, not
>   independently audited** — I'm explicitly requesting external review of the
>   protocol spec and threat model.
> - Guarantee is **at-most-once context presentation, not exactly-once execution.**
>   The docs spell out exactly what is and isn't guaranteed.
> - AI agents were used heavily for design, implementation, and testing; I directed
>   architecture, the verification gates, and the release.
>
> MIT-licensed, docs include architecture, delivery semantics, security, and a
> threat-model table. Feedback and protocol critique very welcome:
> https://github.com/Kumaraman110/XBus

### 2b. r/ClaudeAI

**Title:**

```
I built XBus: a local message bus so two Claude Code sessions in different terminals can actually talk to each other (Developer Preview)
```

**Body:**

> If you've ever had Claude Code open in two terminals — say one session reasoning
> about architecture and another implementing — you've felt the gap: they can't
> coordinate. You end up copy-pasting between windows yourself. XBus is my take on
> closing that gap.
>
> It's a per-user, same-machine bus. Each Claude session gets a set of `xbus_*` MCP
> tools (`xbus_send`, `xbus_inbox`, `xbus_ack`, `xbus_reply`, `xbus_register`, …) and
> a small checkpoint hook. A durable broker (SQLite/WAL) handles routing, offline
> queue, and recovery. You register an alias in each session ("architect",
> "implementer"), send a message, and it arrives in the other session at its next
> prompt; that session acks and replies, with correlation preserved.
>
> Being upfront about how it works and where it doesn't:
> - **Public Developer Preview** — not production-ready.
> - **Windows-first** — macOS/Linux are implemented but not yet runtime-validated.
> - **On Bedrock**, delivery is a deferred hook at the receiver's next checkpoint
>   (its next prompt). **Idle-wake is not supported on Bedrock** — a fully idle
>   session isn't woken; it receives at its next activity. Auto Stop-continuation is
>   off by default. (Live Channel push only works on providers where Channels are
>   available.)
> - The body of a message is shown to the model **once**; re-showing it requires an
>   explicit, audited redelivery. It's **at-most-once context presentation, not
>   exactly-once execution.**
> - **Same-machine, same-user only.** Not a sandbox against malware running as you.
> - The custom transport is **internally reviewed, not independently audited.**
> - AI agents (including Claude) were used heavily across design, implementation,
>   and testing; I directed the architecture, verification gates, and the release.
>
> MIT. Quickstart is in the README. Would love feedback from anyone running
> multi-session workflows: https://github.com/Kumaraman110/XBus

---

## 3. LinkedIn (longer-form, professional)

> **Coordinating independent AI coding sessions: open-sourcing XBus (Developer Preview)**
>
> A pattern I kept hitting while working with AI coding tools: I'd have two or three
> Claude Code CLI sessions running at once — one focused on architecture, another on
> implementation, another on tests — and they had no way to coordinate. Each session
> is its own isolated process. Handing a question or a result from one to another
> meant me acting as the message bus, copy-pasting between terminals.
>
> So I built the bus. **XBus** is an open-source, per-user, same-machine
> message bus that lets independently launched Claude Code sessions discover each
> other, send messages, acknowledge them, and exchange correlated replies — backed
> by a durable broker that survives crashes and restarts.
>
> A few design choices I think are worth discussing:
>
> - **Durability first.** A message is persisted (SQLite in WAL mode) before the send
>   call returns, so an offline recipient still receives it on reconnect, and the
>   broker can restart without losing queued work.
> - **A custom secure transport.** The local IPC channel (a Windows named pipe or a
>   Unix domain socket) is treated as untrusted. On Windows, a named pipe's access
>   control isn't settable from Node's networking API, so rather than depend on a
>   separate native proxy, the channel is wrapped in a pure-Node protocol (XBUS-STP):
>   mutual installation-membership auth, per-frame AES-256-GCM, and replay/reorder
>   rejection, built from standard primitives.
> - **Honest delivery semantics.** I deliberately do not claim exactly-once
>   execution — a language model's decision to act isn't an event the bus can observe
>   or fence. What it guarantees is at-most-once presentation of a request to the
>   model on any normal recovery path, with explicit, audited redelivery as the only
>   way to re-present a body. The docs lay out what is and isn't guaranteed, layer by
>   layer.
>
> I want to be equally clear about the limitations, because credibility matters more
> than launch buzz:
>
> - This is a **Public Developer Preview**, not production-ready.
> - It is **Windows-first.** macOS and Linux are implemented but not yet validated on
>   real hardware.
> - It is **same-machine, same-user** software — it defends against accidental
>   cross-session access and forged local traffic, but it is **not** a sandbox against
>   malicious code running as your own user.
> - The transport has been **internally reviewed and adversarially tested, but it has
>   not had an independent security audit** — and I'm actively requesting external
>   review of the protocol and threat model.
> - On Amazon Bedrock, delivery is deferred to the receiver's next checkpoint; idle
>   sessions are not woken.
>
> One more thing I'll state plainly: **AI agents were used extensively** throughout
> the design, implementation, code review, and testing of this project. I directed
> the architecture, set the verification gates, and made the release decisions — but
> this was very much human-directed, AI-assisted engineering, and I think that's
> worth being transparent about rather than hiding.
>
> It's MIT-licensed and the documentation includes the architecture, the full
> delivery-semantics writeup, a security threat-model table, and a roadmap of what
> still needs validation. If you work on developer tooling, local IPC security, or
> multi-agent coordination, I'd genuinely value your critique.
>
> Repo and docs: https://github.com/Kumaraman110/XBus
>
> #OpenSource #DeveloperTools #AI #ClaudeCode #SoftwareEngineering

---

## 4. X / Twitter (thread)

**Tweet 1/7**

> Run two Claude Code sessions in two terminals and they can't talk to each other.
> No way to hand work from one to another, no way to get an answer back. You become
> the message bus.
>
> So I built the actual bus. Open-sourcing XBus (Developer Preview) 🧵
> https://github.com/Kumaraman110/XBus

**Tweet 2/7**

> XBus is a per-user, same-machine message bus for independent Claude Code CLI
> sessions.
>
> Register an alias in each session → send a message → it arrives in the other
> session at its next prompt → that session acks and replies, with correlation
> preserved.

**Tweet 3/7**

> It's durable. A message is persisted to SQLite (WAL) *before* send returns, so:
> - an offline recipient still gets it on reconnect
> - the broker can restart without losing queued messages
> - crash / reconnect recovery is built in

**Tweet 4/7**

> The local IPC (named pipe / Unix socket) is treated as untrusted and wrapped in a
> custom transport, XBUS-STP: mutual auth, per-frame AES-256-GCM, replay/reorder
> rejection.
>
> Important: it's internally reviewed and adversarially tested — NOT independently
> audited. I'm requesting review.

**Tweet 5/7**

> Honest limits, because overclaiming helps no one:
> - Public Developer Preview, not production-ready
> - Windows-first; macOS/Linux implemented but not yet runtime-validated
> - same-machine, same-user only — NOT a sandbox against malware running as you

**Tweet 6/7**

> On the guarantee: it's at-most-once context *presentation*, not exactly-once
> *execution*. A model's decision to act isn't something the bus can observe or
> fence. The body is shown once; re-showing requires an explicit, audited
> redelivery. On Bedrock, delivery is deferred to the next checkpoint (no idle-wake).

**Tweet 7/7**

> Built human-directed, AI-assisted: agents did a lot of the design/impl/review/test;
> I owned the architecture, the verification gates, and the release.
>
> MIT. Docs cover architecture, delivery semantics, and the threat model. Critique
> very welcome 👇
> https://github.com/Kumaraman110/XBus

---

## 5. Claude Code / MCP community channels (short post)

> **XBus (Developer Preview)** — a local message bus so independent Claude
> Code CLI sessions on one machine can coordinate.
>
> Each session gets `xbus_*` MCP tools (`xbus_send`, `xbus_inbox`, `xbus_ack`,
> `xbus_reply`, `xbus_register`, …) plus a checkpoint hook; a durable SQLite-backed
> broker handles routing, an offline queue, and crash/restart recovery. The local
> IPC is wrapped in a custom secure transport (XBUS-STP: mutual auth, per-frame
> AES-256-GCM, replay/reorder rejection).
>
> Honest status: Public Developer Preview, not production-ready. Windows-first
> (macOS/Linux implemented but not yet runtime-validated). Same-machine, same-user
> only — not a sandbox against your own user. On Bedrock, delivery is deferred to the
> receiver's next checkpoint (no idle-wake). Guarantee is at-most-once context
> presentation, not exactly-once execution. The transport is internally reviewed and
> adversarially tested, **not** independently audited — review requested. Built
> human-directed, AI-assisted (agents did much of the design/impl/review/test; I
> owned architecture, gates, and the release).
>
> MIT, docs + quickstart in the repo. Feedback from multi-session / MCP folks
> especially welcome: https://github.com/Kumaraman110/XBus
