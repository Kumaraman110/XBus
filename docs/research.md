# XBus Platform Research & Phase-0 Capability Findings

**Research date:** 2026-06-24 / 2026-06-25
**Installed Claude Code:** 2.1.186 (`claude.exe`, 225 MB SEA at `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`)
**Host:** Windows 11, Node v25.8.1, npm 11.12.1, **Bun absent**
**Auth/provider regime (this machine):** Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`, via a `mars-azure-openai-proxy` Bedrock endpoint)

Evidence tiers used throughout: **DOCUMENTED** (official code.claude.com), **LOCALLY-OBSERVED** (this binary/host), **INFERRED**, **UNVERIFIED**.

---

## 1. Channels exist and the XBus architecture is valid against documented Claude Code

**DOCUMENTED** (code.claude.com/docs/en/channels, /channels-reference, /plugins-reference, /cli-reference):

- A **Channel** is an MCP server that pushes events into a running Claude Code session. Two-way capable. *"Events only arrive while the session is open."*
- Launch flag: `claude --channels plugin:<name>@<marketplace>` (research preview, needs CC ≥ 2.1.80; we have 2.1.186).
- Dev/local flag: `claude --dangerously-load-development-channels plugin:<name>@<marketplace>` or `server:<name>` (bypasses the allowlist per-entry after a confirmation prompt).
- Injection format: arrives in-session as `<channel source="<server-name>" key="val" ...>content</channel>`.
- MCP contract (channels-reference, verbatim):
  - Capability: `capabilities.experimental['claude/channel'] = {}` — *"Required. Always {}. Presence registers the notification listener."*
  - Push: notification method `notifications/claude/channel` with params `{ content: string, meta: Record<string,string> }`.
  - `meta` keys must be `[A-Za-z0-9_]`; *"Keys containing hyphens or other characters are silently dropped."*
  - `source` attribute is set automatically from the MCP server's configured `name`.
- `plugin.json` has a **top-level `channels` array**: `[{ "server": "<must match an mcpServers key>", "userConfig?": {...} }]`.
- Optional permission relay: `capabilities.experimental['claude/channel/permission']` (CC ≥ 2.1.81). **XBus does NOT and MUST NOT declare this.**
- Per-session identity: `CLAUDE_CODE_SESSION_ID` is exported to stdio MCP subprocesses; an MCP server *retains the id it was spawned with*. `CLAUDE_CODE_CHILD_SESSION` is **not** set for stdio MCP subprocesses.

**Conclusion:** the XBus design (per-session channel plugin + MCP server + a user-level rendezvous broker keyed on `CLAUDE_CODE_SESSION_ID` + `<channel>` injection + reply tool) is architecturally valid against documented Claude Code. The earlier working hypothesis that "2.1.186 has no Channel extension point" is **DISPROVEN**.

### Correcting the `--help` artifact
`claude --help` in 2.1.186 contains **zero** occurrences of "channel". This is **not** evidence of absence — `--channels` and `--dangerously-load-development-channels` are gated research-preview flags hidden from `--help`. Proven by direct parser probe (§3).

---

## 2. SendMessage / Agent Teams is NOT a cross-session transport

**DOCUMENTED** (code.claude.com/docs/en/agent-teams) + **LOCALLY-OBSERVED** (in use this session):

- `SendMessage` is a strictly **in-session, model-invoked** tool. There is **no** documented programmatic/external/CLI contract to inject a message into an independent running session from outside.
- A team = one lead (the spawning session) + teammates it spawned, scoped to that one session. One team per session; no cross-session sharing; no nested teams.
- **LOCALLY-OBSERVED nuance:** the `SendMessage` *tool* is available and fully functional in this session (round-trips verified, substantive bidirectional replies received) **even though `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is not present in the environment**. The mandate's stop-condition (SendMessage unavailable because the flag wasn't set) therefore does **not** trigger.

**Conclusion (Phase 4):** `NativeSendMessageTransport` cannot be a production cross-session transport. It remains interface-only / disabled. Cross-session rendezvous must be XBus's own (a user-level broker over local IPC keyed on `CLAUDE_CODE_SESSION_ID`).

---

## 3. Direct flag-parser probe (LOCALLY-OBSERVED, decisive)

Method: invoke the real binary with each flag and an intentionally-bad value, stdin closed, **without** `--help` (appending `--help` short-circuits the parser to exit 0 and proves nothing — an earlier invalid test).

| Flag | Exit | Parser verdict |
|---|---|---|
| `--definitely-not-a-real-flag-xyz123` (control) | 1 | `error: unknown option` → parser **rejects** unknown flags |
| `--channels` | 1 | `--channels entries must be tagged: …` + usage showing `plugin:<name>@<marketplace>` / `server:<name>` → **flag RECOGNIZED** |
| `--dangerously-load-development-channels` | 1 | advanced past parsing to a later stage → **flag RECOGNIZED** |

**Both channel flags exist in this exact 2.1.186 Bedrock binary.**

---

## 4. THE BLOCKER — channel injection is silently dropped on Bedrock (empirically classified)

**DOCUMENTED** (channels page, verbatim): *"They require Anthropic authentication through claude.ai or a Console API key, and are not available on Amazon Bedrock, Google Vertex AI, or Microsoft Foundry."*

### Empirical confirmation on this machine (LOCALLY-OBSERVED)

Built a spec-correct minimal channel (`spike/`): declares `experimental['claude/channel']={}`, emits `notifications/claude/channel` with `content`+`meta`, exposes a safe `xbus_spike_ack` tool, declares **no** permission relay. `claude plugin validate --strict` **passed**.

Loaded it into the **real** binary via `--dangerously-load-development-channels server:xbus_spike` in a 2-turn `stream-json` session, with `--debug 'channel,mcp,plugin'`. The locally-observed evidence:

| Observation | Evidence |
|---|---|
| CC spawned + connected our server | debug: `MCP server "xbus_spike": Successfully connected (transport: stdio)`, `hasTools:true` |
| Channel capability accepted at MCP layer | handshake completed, no error |
| Channel tool callable | tool list includes `mcp__xbus_spike__xbus_spike_ack` |
| `CLAUDE_CODE_SESSION_ID` reaches MCP subprocess, **distinct per session** | spawned env `32df31fc-…` ≠ main session `9f0376a3-…` |
| `CLAUDE_CODE_CHILD_SESSION` null in MCP subprocess | matches docs |
| Server emitted **7** `notifications/claude/channel` pushes during the live session | frame log |
| **Model received NO `<channel>` tag** | model's own turn-2 reasoning: *"I do not see any `<channel>` tag anywhere"* → replied `NO_CHANNEL_EVENT_SEEN` |
| **Channel subsystem entirely inert** | full 45 KB debug log with `channel` category enabled contains **zero** occurrences of "channel"; CC wired our server as a plain MCP server, never engaged channel registration |

### Classification (per the 13-cause checklist)
Ruled **OUT**: plugin/manifest invalid (validate passed), capability-key wrong (accepted at MCP layer), wrong executable (verified `CLAUDE_CODE_EXECPATH`), server-name/`channels.server` mismatch (single server, matches), MCP server didn't declare capability (it did).

Ruled **IN** (the cause): **unsupported auth/runtime provider** — `CLAUDE_CODE_USE_BEDROCK=1`. On this Bedrock build the host never engages the channel-registration machinery, so `notifications/claude/channel` pushes have no consumer and are silently discarded. This is the **documented** Bedrock gate, confirmed three independent ways (model saw nothing; server emitted 7 ignored pushes; debug shows no channel engagement). A secondary contributor (headless mode cannot accept the dev-channel confirmation prompt) is also present but is not the root cause — the debug trace shows the subsystem never engages at all.

**This is a verified environmental restriction, not an implementation defect.** Per the mandate it triggers: present evidence + Channel-vs-monitor comparison + recommendation; do **not** silently redesign; stop before the full build.

### What this costs (from reliability-tester's AC re-map)
- **NOT testable on this host:** any criterion whose evidence requires a live Claude to *receive* an injected message (live A→B delivery, live app-ack, live reply, the two-session interactive exchange).
- **Still fully testable here** (transport-agnostic core, the large majority): all delivery-state-machine transitions, fencing/split-brain, durability/broker-restart, registration/alias-uniqueness, disconnect/replay, no-repo-files, redaction, ack/completion *semantics* via a FakeChannelHost, and Windows-named-pipe + in-memory transport contracts (UDS leg on a Unix CI runner).
