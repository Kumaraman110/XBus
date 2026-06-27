# Building XBus: a durable local message bus for independent Claude Code sessions

Independent Claude Code sessions cannot reliably coordinate across terminals. XBus gives them a durable local communication layer.

That sentence is the whole motivation, so it is worth saying plainly before any
architecture. If you have ever run two Claude Code sessions side by side — an
"architect" reasoning about a design in one terminal and an "implementer"
writing code in another — you have probably noticed that the two are completely
blind to each other. There is no built-in way for one session to hand work to
the other, ask it a question, or receive a correlated answer. You end up being
the message bus yourself: reading from one window, pasting into the other,
carrying context back and forth by hand.

This article is a technical write-up of how XBus closes that gap, what
broke along the way, and — just as importantly — what it deliberately does not
promise. It describes the `v0.1.0-beta.2` Public Developer Preview. XBus
was created and is maintained by **Aman Kumar**, who directed the architecture,
the verification gates, and the release decisions; **AI agents were used
extensively** throughout design, implementation, review, and testing. There has
been **no independent human security audit** — a point we return to honestly
below.

## 1. The original problem

The unit of work in Claude Code is a session. Each session is an isolated
process with its own context window, its own working directory, and its own
identity (`CLAUDE_CODE_SESSION_ID`, exported to the MCP subprocesses it spawns).
Two sessions launched in two terminals are two unrelated processes. There is no
shared channel, no rendezvous point, no addressing scheme that lets one find and
talk to the other.

What we wanted was modest to state and surprisingly involved to build: a way for
one session to *send a message to another session by name*, have that message
*survive* if the recipient is busy or not yet listening, be *delivered exactly
into the recipient's context once*, be *acknowledged*, and produce a *correlated
reply* that finds its way back to the original sender. In other words, a small,
durable, local message bus — scoped to a single machine and a single OS user,
because that is the real coordination scenario (your terminals, your account)
and because crossing either boundary is a much larger security problem.

## 2. Why ordinary subprocess / same-session messaging was insufficient

The obvious first instinct is to reach for a mechanism Claude Code already has.
We evaluated the candidates empirically against the real CLI binary rather than
trusting documentation, and each fell short for cross-session coordination:

- **Agent Teams / `SendMessage`.** This is a strictly *in-session,
  model-invoked* tool. A "team" is one lead session plus the teammates it
  spawned, scoped to that one session — one team per session, no cross-session
  sharing, no nested teams. There is no documented programmatic or external
  contract to inject a message into an *independently launched* session from the
  outside. It is genuinely useful, but it is not a cross-session transport, so we
  kept our `SendMessage`-style integration interface-only and disabled.

- **Plain subprocess pipes / a shared file.** A naive shared file or pipe gives
  you a byte stream but none of the properties that make coordination correct:
  no durable identity, no per-message dedup, no acknowledgement, no fencing of a
  stale process, no integrity against a local peer who knows the path. You would
  be re-implementing a broker badly.

The conclusion was that cross-session rendezvous had to be **XBus's own**: a
per-user broker, running as a singleton process, that owns a durable store and
addresses sessions by a stable identity. Sessions connect to it over local IPC;
the broker does routing, authorization, scheduling, and recovery. Everything
else in the design follows from taking that broker seriously.

## 3. The Bedrock constraint: checkpoint delivery, not idle wake

Here the environment forced the single most consequential design decision.
Claude Code does have a native push mechanism — **Channels**, an MCP server that
pushes events into a running session. On paper it is exactly the "receive leg" a
bus needs. But Channels require Anthropic authentication through claude.ai or a
Console API key and are **documented as unavailable on Amazon Bedrock** (also
Vertex AI and Foundry). The primary development host for this project runs on
Bedrock.

We did not take the documentation on faith. We built a spec-correct minimal
channel, validated it with `claude plugin validate --strict`, loaded it into the
real binary, and emitted seven channel notifications during a live session with
channel-level debug tracing on. The model reported it saw no `<channel>` tag;
the debug log — with the `channel` category enabled — contained zero channel
engagement; the CLI wired our server as a plain MCP server and silently
discarded the pushes. This is a *verified environmental restriction, not an
implementation defect*, and it is reproducible three independent ways.

So instead of pretending Channels work, XBus delivers via a **checkpoint hook**.
We classified every Bedrock-surviving injection mechanism against a strict
standard ("an idle recipient is automatically scheduled, processes the message,
acknowledges, and returns a correlated result without hidden human activity").
The empirically proven floor is a `Stop` hook that drains the recipient's inbox
at a turn boundary: the model then processes and replies autonomously. That is
the active receive mode, named `hook_checkpoint`.

The honesty cost is stated everywhere it matters: **there is no idle wake on
Bedrock.** A completely idle session is *not* woken — it receives at its next
lifecycle checkpoint (its next prompt or Stop). The sender is therefore told the
*true* state, `queued_until_checkpoint`, never "delivered". A `live` push mode
exists in the design for providers where Channels actually work, but on Bedrock
it is not claimed. We never label checkpoint delivery "real-time push".

## 4. Durable messaging, acknowledgements, and correlated replies

With the transport classified, the core became a durable broker over
`node:sqlite` in WAL mode. (We chose the Node built-in over `better-sqlite3`
specifically to avoid a native-compile dependency — that decision pays off in
packaging, below.) The delivery path is deliberately ordinary and boring, which
is the point:

1. `xbus_send` resolves the recipient and **durably persists the message — one
   row — before the ack returns.** A send that times out can be retried safely:
   a unique index on `(sender_session_id, idempotency_key)` with `INSERT … ON
   CONFLICT` returns the original `messageId` rather than creating a second row.
2. The message sits `queued`. When the recipient is *ready* (§5 below) and
   reaches a checkpoint, the hook injects it (`transport_written`) and the broker
   issues a one-time receipt.
3. The receiver `xbus_ack`s (accept or reject) and may `xbus_reply`. A reply is a
   correlated message back to the original sender, preserving `correlationId` and
   `causationId`, so a multi-step exchange threads correctly.
4. A periodic **reaper** reclaims ack-timeouts, acceptance-TTL expiries, and
   abandoned delivery leases, with a per-session fairness cap so one session
   cannot starve the others.

A subtle but load-bearing guarantee lives here: **at-most-once *context
presentation*, explicitly not exactly-once *execution*.** XBus layers four
distinct dedup mechanisms — durable-row dedup (the `idempotencyKey` index), a
context-injection ledger unique per `(message, epoch, logical_injection_number)`,
and model-visible body dedup in the inbox — so that no normal recovery path
(a repeated inbox read, a repeated checkpoint pull, a reconnect, or a broker
restart) ever shows the same request body to the model twice. The first read
includes the body once; a recovery read returns metadata with
`bodyAlreadyPresented: true` and `bodyIncluded: false`. The *only* way to
re-present a body is an explicit, audited `xbus_redeliver`, which allocates a new
logical injection number, emits an `EXPLICIT_REDELIVERY` event, and warns that
the model may now process the request twice.

What XBus does **not** claim is the fourth layer: application side-effect
idempotency. "The model decided to call a tool / hit an API / write a file" is an
action XBus neither observes nor controls. We give the application the stable
identifiers (`messageId`, `correlationId`, the per-message `injection_id`) to
dedup its own external writes, but using them is the application's job. Claiming
exactly-once execution would require observing the model's internal decision and
atomically fencing the side effect with the acknowledgement — XBus can do
neither, so it does not pretend to.

## 5. Identity and stale-process fencing

Authority is the part that is easy to get subtly wrong. The naive model conflates
"logical session", "generation", and "component", and a live test caught exactly
that: a session's hook and its MCP server are *two components of the same logical
session* that connect separately. Authorizing acknowledgements by "any component
of the current generation" was both too coarse and produced a reconnect-clobber
bug where a reconnecting component disturbed in-flight deliveries.

The fix is a three-layer identity model:

- **LogicalSession** — the stable, addressable id (`CLAUDE_CODE_SESSION_ID`).
- **SessionEpoch** — a lifecycle generation that advances **only on a proven
  supersede** (a `--resume` claiming a session whose prior owner is gone, or an
  operator-forced takeover) — *never* on a mere component reconnect.
- **ComponentInstance** — a specific connected process (`mcp`, `hook`,
  `transport`, `cli`, `admin`) within an epoch.

Authority is bound to the **authenticated connection** (session + epoch + role),
not to a bearer token. When a message is injected, the model only ever sees a
**non-secret `injection_id`**, safe to appear in a transcript: a leaked
`injection_id` grants nothing from another session, because `xbus_ack` /
`xbus_reply` are authorized by the connection's identity and a one-time receipt
ledger prevents replay. The epoch boundary is the fencing mechanism — a genuine
supersede resets readiness, and a stale prior-epoch signal is rejected so a
superseded owner cannot leak its state into the new epoch.

This also drives **readiness**, which is orthogonal to dedup: a session that has
registered but not finished initializing is *connected but not ready*, and the
broker holds its messages durably queued rather than injecting a `requires_ack`
request the receiver cannot yet acknowledge. Readiness is derived from concrete
capability hints, never trusted from a client that merely asserts it is ready.

## 6. Windows named-pipe security: the XBUS-STP decision (ADR 0010)

The broker IPC is a Windows named pipe (a Unix domain socket on macOS/Linux).
The uncomfortable fact is that **Node's `net` API cannot set a named pipe's
security descriptor on Windows** — the pipe is created with a default descriptor
that may grant access beyond the intended user. So the pipe must be treated as an
**untrusted byte transport** until authenticity is established.

We prototyped two options. **Design A** uses a secured native pipe via .NET's
`NamedPipeServerStreamAcl` — OS-enforced, but Node cannot create a secured pipe,
so it requires a separate .NET process (a pipe-proxy in front of the Node
broker). That adds a .NET runtime dependency to every install, a second process,
frame forwarding, and version coordination — directly violating the
offline / no-extra-runtime packaging contract. **Design B** puts the
cryptographic boundary in pure Node: a per-installation 256-bit root secret in
the ACL-restricted data dir, a mutual nonce challenge-response, an HKDF-SHA256
per-connection key schedule, per-frame AES-256-GCM with per-frame AAD, sequence
based replay/reorder rejection, and a uniform `AUTH_FAILED` with no oracle.

We chose Design B — **XBUS-STP** — because it is the only option satisfying both
byte-level authenticity *and* the no-extra-runtime packaging contract, and it is
actually stronger on authenticity: Design A authenticates only who may *connect*,
while B authenticates *every byte* and rejects replay, tamper, and reorder. The
named residual risk is honest: B does not restrict who may *open* a connection,
so an unauthenticated peer can force handshake work. That DoS surface is bounded
by a connection cap, per-connection handshake/idle timeouts, a global
buffered-byte budget, and a connect-rate token bucket.

The most important thing we say about XBUS-STP is a humility statement, recorded
in ADR 0010 itself. AES-256-GCM, HKDF-SHA256, and HMAC-SHA256 are standard,
well-reviewed **primitives** — but the handshake, transcript construction, key
schedule, frame format, replay rules, and rotation behavior are an
**XBus-specific protocol composed from those primitives.** "No custom cipher, no
custom MAC" is accurate; "no custom crypto protocol" is **not** — we composed
one, and a composed protocol is not automatically secure just because its
primitives are. That is why XBUS-STP has a normative specification, deterministic
test vectors, and adversarial tests (reflection, downgrade, identity
substitution, nonce reuse, transcript binding). It is **internally reviewed and
adversarially tested, but NOT independently audited.** XBus deliberately has **no
forward secrecy** — keys derive from the long-lived root secret plus nonces — and
that is justified, not hidden: against the same-user threat model, an attacker
who can read the root secret already has your privileges, so recording-then-later
compromise adds little. We are actively requesting external review.

## 7. What the internal hardening caught

A bus that works on the developer's machine and falls over the moment it is
packaged is not shippable. The internal hardening rounds existed precisely to
find the failures that only appear away from the dev loop, and several were
instructive:

- **Silent no-op packaging commands.** A packaging path could "succeed" while
  having effectively done nothing — exit zero, produce a tree, but not actually
  stage what was intended. A green exit code is not proof of work. The fix was to
  make packaging assert its own output: the integration test now verifies the
  staged tree is toolchain-free (no `.node` addons, no `binding.gyp`, no
  forbidden deps like `better-sqlite3`/`typescript`/`vitest`), that every shipped
  file appears in `SHA256SUMS` with a recomputed sample, that every dependency
  appears in the CycloneDX SBOM with a concrete version, and that a content
  scanner finds no private paths or developer identity.

- **A non-installable artifact.** A produced package was not actually
  installable end-to-end — the staged tree alone was not the same thing as a
  thing a user could run. This is why packaging and the (gated) real install are
  treated as separate, separately-verified steps, and why the clean-profile
  lifecycle (fresh install, upgrade, incompatible upgrade, rollback, offline
  after install, uninstall) is automated rather than assumed.

- **A build-identity / provenance ambiguity (ADR 0011).** Earlier on, a single
  field named `buildId` did two jobs: it was the value bound into
  the XBUS-STP handshake transcript, *and* it was documented as if it were the
  exact identity of a build. But that value was only a compatibility tuple with
  no commit, so two materially different source builds produced
  an *identical* string and were operationally indistinguishable in the field —
  `xbus version`, `doctor`, the manifests, and the handshake all reported the
  same thing. This was a provenance defect, not a security defect: the binding it
  performed was correct. The fix split the concepts into five non-overlapping names:
  `productVersion`, an *exact deterministic* `buildId` (`xbus-<version>-<commit>`,
  diagnostics only, never on the wire), `sourceCommit`, the stable
  version-independent `compatibilityId` (`xbus-p1-stp1-s5`, the value the wire
  field actually carries), and `artifactManifestSha256`. Crucially, this was
  **not** an STP version bump — the wire bytes, key schedule, and test vectors are
  byte-for-byte unchanged; exact identity now rides in authenticated,
  post-handshake registration, never in the handshake.

- **A missing data-root migration on upgrade.** Different components (the broker,
  `doctor`, the MCP server, the checkpoint hook, the launcher) could resolve a
  *different* canonical data directory, and an upgrade could leave existing data
  stranded under the old root. The fix was a single canonical data root that all
  components resolve identically, plus a **transactional data-root migration on
  upgrade** — so an upgraded install carries its existing data forward instead of
  silently starting empty.

## 8. The real installed migration proof

The data-root fix is the kind of claim that is worthless without evidence, so it
was proven on a real installed instance, not in a unit test. The clean-profile
lifecycle harness installs a candidate, writes real broker state, then installs a
newer build over it and asserts the data survives: **data written by the earlier
build was preserved across the upgrade.** On first start after an upgrade the broker also applies any
pending schema migrations, and the upgrade path is fail-closed in both
directions — checksum drift on a migration, or a database *newer* than the
running code, aborts with an actionable message rather than risking corruption
(old code refuses a newer schema). After upgrading, `xbus doctor` reports the
exact `buildId`, `sourceCommit`, the installed `artifactManifestSha256`, and a
`mixedBuilds` verdict, so an operator can confirm the broker is actually running
the build they just installed.

## 9. Honest limitations

We would rather understate than overstate, so the limitations are stated as
plainly as the value:

- **Public Developer Preview — not production-ready.** The MCP tool surface, the
  frame protocol, and the schema may change between preview releases.
- **Windows-first.** macOS and Linux are implemented (Unix socket + mode
  hardening) but **not yet runtime-validated** on a real machine.
- **Same-machine, same-user only.** XBus is **not a sandbox** against malware
  running as your own fully-privileged user — such code can read the data dir,
  the root secret, and your Claude config directly regardless.
- **Cross-user Windows execution is unvalidated.** The same-user boundary is
  proven; cross-user has no second-account test environment yet.
- **Bedrock = deferred checkpoint delivery, no idle wake.**
- **At-most-once context presentation, NOT exactly-once execution.**
- **XBUS-STP is internally reviewed and adversarially tested, but NOT
  independently audited.**

Performance is reported the same way — as indicative numbers from a single
developer machine, not a spec. Over the *encrypted* transport, handshake p95 was
~3.5 ms, send round-trip p95 ~3.4 ms, inbox round-trip p95 ~5.7 ms, and sustained
throughput ~427 msg/sec — all comfortably inside the project's targets (handshake
< 150 ms, round-trips < 50 ms, > 200 msg/sec). Encryption is not the bottleneck.
Reproduce them yourself with `npm run bench`; they will vary with hardware, OS,
and Node version.

## 10. Roadmap

The preview is deliberately a starting point, and the gaps are exactly where
contribution is most useful:

- **macOS / Linux runtime validation** — the code exists; it needs real-platform
  proof.
- **Cross-user Windows validation** — exercise the cross-account boundary on a
  multi-account host.
- **Live push delivery** where a provider supports idle wake (beyond Bedrock
  checkpoint mode).
- **Independent security review** of XBUS-STP and the threat model — the single
  most-wanted external contribution.
- **A real, code-signed installer** — the artifact is already verifiable
  (per-file checksums, a single manifest checksum, a CycloneDX SBOM, pinned
  pure-JS deps), but a signed installer is a release-time step not yet done.
- **A body-free observability surface** — structured operational metrics that
  never carry message content.

Explicitly *out of scope* for now: a cross-machine or networked bus (XBus is
deliberately same-machine), a sandbox against your own privileged user, and
exactly-once execution guarantees.

---

XBus is, at heart, a small idea taken seriously: give independent Claude
Code sessions a durable, addressable, authenticated way to talk on one machine,
and be relentlessly honest about the boundary of what that guarantees. The
durable store, the layered dedup, the connection-bound authority, and the
composed-but-unaudited transport are each conservative choices that say "here is
exactly what we proved, and here is exactly what we did not." Aman Kumar directed
that architecture and those verification gates; AI agents did extensive design,
implementation, review, and testing under that direction. The code is a Public
Developer Preview, the security has not had an independent audit, and the most
valuable thing a reader can do is help close one of the gaps above. The source,
the ADRs, and the normative XBUS-STP spec are all public at
github.com/Kumaraman110/XBus.
