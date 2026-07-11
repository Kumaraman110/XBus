# Beta.4 zero-friction acceptance runbook

**Goal (ADR 0012):** after ONE user-level install, from a fresh terminal in any
directory, plain `claude` loads XBus, auto-starts the broker, auto-registers a
uniquely-named session, makes it discoverable, and delivers messages at checkpoints —
with no `xclaude.js` and no `xbus start`. And after 15 days of inactivity a session
expires, releases its name, becomes unroutable, and is not resurrected.

This runbook splits the **Mandatory Windows Acceptance** (directive Step 8, 27 steps)
into what is **automated** (run the script — no human needed) and the **irreducible
interactive steps** that require a human driving the *real* Claude Code CLI with a
model. Do NOT mark beta.4 accepted until the interactive section passes on a clean
Windows profile.

---

## A. Automated acceptance — run this first

```powershell
# Supported Node (22 LTS / 24) on PATH. The script is fully isolated: it never
# touches your real ~/.claude, ~/.claude.json, or ~/.claude/settings.json (it points
# CLAUDE_CONFIG_PATH / CLAUDE_SETTINGS_PATH / HOME at a temp tree and uses a fake
# claude host). No `xbus`/`xclaude` on PATH is needed.
npm run build
node scripts/beta4-accept.mjs            # uses ./dist
# expected last line: RESULT: BETA4_AUTOMATED_ACCEPTANCE_PASS
```

This proves, end-to-end, without a live model:

| Directive acceptance step | Automated by the script |
|---|---|
| 1-2 extract + install once | `install --json`, asserts `ok` |
| 7 user-level XBus MCP loaded | asserts `mcpServers.xbus` in `.claude.json` |
| (B1) hooks load at user scope | asserts XBus `UserPromptSubmit`+`Stop` hooks in `.claude/settings.json` (NOT in `.claude.json`, where Claude ignores them) |
| 8 broker starts automatically | two MCP processes; first tool call auto-starts the broker (no `xbus start`) |
| 9-10 session registers + named | both sessions discoverable BY NAME, `sessionNameState='active'` |
| 14-15 two sessions discover + exchange | A routes to B **by name**; request → ack → correlated reply; fire-and-forget |
| 19-20 concurrency → one broker | 8 concurrent `ensureBroker` callers → ONE broker, 0 extra spawns |
| 21-22 duplicate + pending names | same-name collision → second `pending` → `xbus_rename` → `active` |
| 23-25 15-day expiry | injected `FakeClock`: active at 14d23h59m; expired + name released + queue dead-lettered after 15d; old bodies not resurrected on re-register (covered by the test suite) |
| 26-27 uninstall + restoration | uninstall removes ONLY XBus entries from BOTH config files; user's other entries intact |

The full broker-correctness matrix (beta.3 invariants + the beta.4 features) is also
covered by `npm test` + `npm run verify:release` (the 15-stage release gate).

---

## B. Irreducible interactive steps — a human must run these

These require the **real** Claude Code CLI with a model attached; they cannot be
machine-driven (the automated script uses a fake host so it can never launch your
real Claude). Run on a **clean Windows user profile** if possible.

### B.1 — Clean install + plain `claude` (steps 1-10)

```powershell
# 1-3: install once from the release asset, then CLOSE the install shell.
#      (Follow INSTALL.txt in the asset — install is PATH-free.)
node "<pluginDir>\dist\cli\main.js" install
#      -> success message should say: "just run plain 'claude' from any directory".

# 4-6: open a FRESH PowerShell, cd into a real project, run PLAIN claude.
cd C:\Projects\App-A
claude
```

Verify by eye / via `node "<pluginDir>\dist\cli\main.js" doctor`:
- **7** XBus MCP server is loaded (Claude lists the `xbus` MCP tools — try `xbus_status`).
- **8** the broker started automatically (no `xbus start` was run; `doctor` shows it reachable).
- **9** the session auto-registered.
- **10** it got a sensible suggested name (e.g. `app-a` from the dir/repo), OR Claude
  asked you to choose one (if the suggestion was taken/unsuitable). If asked, the
  model uses `xbus_rename` and the session becomes routable.

### B.2 — Two sessions discover + exchange (steps 11-15)

```powershell
# 11-13: open ANOTHER fresh PowerShell, cd into a DIFFERENT project, run plain claude.
cd C:\Projects\App-B
claude
```

- **14** ask each session to `xbus_sessions` — each should see the other by its name.
- **15** from App-A, `xbus_send` a request to App-B's name with `requiresAck`+`requiresReply`;
  confirm App-B receives it **at its next checkpoint** (the hook injects it), acks, and
  replies; App-A sees the correlated reply. Repeat with a fire-and-forget (`requiresAck:false`).

### B.3 — Broker restart / recovery (steps 16-18)

- **16** restart or crash the broker (`node "<pluginDir>\dist\cli\main.js" stop`, then
  trigger any tool call — it auto-restarts).
- **17** confirm both sessions reconnect and messaging resumes.
- **18** confirm **no automatic repeated body**: a message already injected is not
  re-presented after the restart (only explicit redelivery re-shows a body).

### B.4 — Concurrency, duplicate, pending (steps 19-22)

- **19-20** launch several `claude` sessions concurrently from the same project; confirm
  via `doctor` that exactly ONE broker is running.
- **21** two sessions from the SAME project: the second detects the name collision and is
  asked to pick another name (no silent suffix).
- **22** confirm a `pending_name` session is NOT discoverable/targetable until it
  `xbus_rename`s to a valid free name.

### B.5 — 15-day expiry (steps 23-25)

The 15-day boundary is proven deterministically by the automated suite (injected clock).
A human cannot wait 15 real days; to spot-check the *routing* behavior, an operator may
use the broker's test clock or simply trust the suite for the timing, and verify the
*observable* outcome: a session reported `expired` by `doctor` is no longer in
discovery, sends to it fail `RECIPIENT_SESSION_EXPIRED`, and after re-registration old
queued bodies do not reappear.

### B.6 — Uninstall + restoration (steps 26-27)

```powershell
node "<pluginDir>\dist\cli\main.js" uninstall
```

- **26** uninstall completes.
- **27** confirm your OTHER MCP servers (in `~/.claude.json`) and OTHER hooks (in
  `~/.claude/settings.json`) are **unchanged** — only the `xbus` entries were removed.
  (Diff the two files against a pre-install backup if you kept one.)

---

## C. Recording the result

When B.1-B.6 pass on a clean profile, record:

```
BETA4_ZERO_FRICTION_CONVERGENCE_PASS
```

Until then the project status is:

```
BETA4_IMPLEMENTATION_AND_AUTOMATED_CONVERGENCE_PASS
REAL_PLAIN_CLAUDE_ACCEPTANCE_PENDING
```

If any interactive step fails, capture the exact step, the `doctor --json` output, and
the broker log; the implementation loop reopens to fix it.

---

## D. macOS / Codex / Hermes (cross-agent hardening — directive Steps 9-10)

The same code is platform-abstracted (Unix-socket endpoint, detached-spawn process
group, `~/.claude.json` + `~/.claude/settings.json` paths, stale-socket unlink is
POSIX-gated). On the Mac:

- **Codex** runs B.1-B.6 against the Codex runtime as an independent reviewer +
  adapter, and confirms the Unix-socket broker auto-start, user-scope config, Codex
  session naming, and inactivity expiry.
- **Hermes** runs the adversarial set: malformed/duplicate-race names, forged activity
  timestamps, heartbeat-retention abuse, expired-session injection, stale epoch reuse,
  broker startup races, hostile capability declarations. The POSIX-only
  `tests/integration/stale-socket-recovery.test.ts` runs there (it is skipped on
  Windows).
