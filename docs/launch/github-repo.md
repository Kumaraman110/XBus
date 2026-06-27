# GitHub repo settings (launch checklist)

Operator notes for configuring the public `Kumaraman110/XBus` repository. Nothing
here is published automatically — apply these in the GitHub UI / `gh` at launch.

---

## Repo description (<= 120 chars)

Pick one (all under the 120-char "About" limit):

```
Durable local message bus so independent Claude Code sessions on one machine can discover each other and talk.
```
(108 chars)

Shorter alternative:

```
Local, durable message bus for cross-talk between independent Claude Code sessions on one machine. Preview.
```
(106 chars)

Keep the description free of overstated guarantees. "Durable" and "local" are
accurate; do not add "secure" without the qualifier in the docs (XBUS-STP is
internally reviewed, **not** independently audited).

## Website field

Point the repo "Website" at the docs index or the roadmap, e.g.
`https://github.com/Kumaraman110/XBus/blob/main/docs/roadmap.md`.

## Suggested topics

GitHub allows up to 20 topics; these are accurate to the actual product:

```
claude
claude-code
mcp
model-context-protocol
ipc
named-pipes
message-bus
message-queue
multi-agent
agent-coordination
sqlite
typescript
nodejs
windows
developer-preview
local-first
secure-transport
aes-gcm
```

Notes:
- `mcp` / `model-context-protocol` — XBus exposes its surface as MCP `xbus_*` tools.
- `ipc` / `named-pipes` — the transport is a Windows named pipe / Unix socket.
- `windows` — primary, validated platform (be honest: not a cross-platform claim).
- `secure-transport` / `aes-gcm` — XBUS-STP; do **not** add a `security` topic that
  implies an audit has happened.
- Avoid `production-ready`, `enterprise`, or `e2e-encryption` topics — none are true.

---

## Repository feature toggles

- **Issues:** on. Issue forms live in `.github/ISSUE_TEMPLATE/` with
  `blank_issues_enabled: false` (forces template use).
- **Discussions:** on (see config below). The issue chooser routes questions there.
- **Security advisories / private vulnerability reporting:** **on.** This is the
  destination the issue-chooser "Report a security vulnerability" link points to,
  and what `SECURITY.md` requires. XBUS-STP is not independently audited, so a
  private channel is essential.
- **Wiki:** off (docs live in `docs/`).
- **Projects:** optional; a single "Preview → 1.0" board is enough.
- **Sponsorships / FUNDING.yml:** not configured for the preview (skipped).
- **Merge button:** prefer "Squash and merge"; require a linear history. PRs run
  the full `npm run verify:release` gate — build, `tsc` strict typecheck, ESLint
  (enforced flat-config, **zero findings required**), the sharded unit / security /
  integration / e2e suites, packaging, and an artifact-first install check.
- **Default branch:** `main`. Protect it: require PR + passing checks before merge.

---

## Discussions configuration (recommended)

Enable Discussions and create these categories:

| Category | Format | Purpose |
|----------|--------|---------|
| Announcements | Announcement (maintainer-post only) | Releases, breaking pre-1.0 changes. |
| Q&A | Question / Answer | Usage help, "bug or known limitation?" triage before an issue is filed. |
| Ideas | Open discussion | Pre-feature-request brainstorming; filter against the roadmap non-goals. |
| Show & tell | Open discussion | Multi-session / multi-agent workflows people build on XBus. |
| Protocol & threat-model review | Open discussion | The dedicated home for the external review we're explicitly requesting (XBUS-STP spec, key schedule, AAD, threat model). |
| Platform validation | Open discussion | macOS / Linux / cross-user Windows results, before or alongside a `[Validation]` issue. |

The issue-template `config.yml` already links Q&A (as "Questions & discussion")
and the roadmap; keep those URLs in sync if categories are renamed.

---

## Labels

GitHub's default label set plus a small project-specific set. **Labels referenced
by the issue forms must exist before the forms can apply them** — create these
first:

| Label | Color (hex) | Used by | Meaning |
|-------|-------------|---------|---------|
| `bug` | `d73a4a` | bug form | Something behaves incorrectly. (default label) |
| `enhancement` | `a2eeef` | feature form | New capability / improvement. (default label) |
| `triage` | `fbca04` | bug + feature forms | Needs maintainer triage. |
| `validation` | `0e8a16` | platform-validation form | A platform/cross-user validation report. |
| `help wanted` | `008672` | platform-validation form | Maintainer wants community help. (default label) |
| `good first issue` | `7057ff` | (manual) | Approachable starter task. (default label) |
| `security` | `b60205` | (manual) | Security-relevant; coordinate privately first. |
| `docs` | `0075ca` | (manual) | Documentation only. |
| `platform: macos` | `c5def5` | (manual) | macOS-specific. |
| `platform: linux` | `c5def5` | (manual) | Linux-specific. |
| `platform: windows` | `c5def5` | (manual) | Windows-specific. |
| `area: transport` | `bfdadc` | (manual) | XBUS-STP / IPC. |
| `area: broker` | `bfdadc` | (manual) | Broker / routing / scheduling / reaper. |
| `area: delivery` | `bfdadc` | (manual) | Dedup / readiness / delivery semantics. |
| `area: mcp` | `bfdadc` | (manual) | `xbus_*` MCP tools. |
| `area: install` | `bfdadc` | (manual) | Install / packaging / upgrade. |
| `wontfix` | `ffffff` | (manual) | Out of scope (often a documented non-goal). |
| `duplicate` | `cfd3d7` | (manual) | Already tracked elsewhere. |

`triage`, `validation`, `bug`, `enhancement`, and `help wanted` are the ones the
YAML forms apply, so create at least those before enabling the forms.

---

## "Good first issue" list (seed issues)

Realistic, genuinely-open tasks drawn from the roadmap's unproven areas and the
preview's known gaps. Each is small enough for a first-time contributor and does
**not** require maintainer-only context. File these as issues and label
`good first issue` (+ the area/platform labels noted).

1. **Run the test suite on Linux and report results.**
   `npm install && npm run build && npm test` on a real Linux box (Node >=22.5).
   The Unix-socket + mode-hardening paths are implemented but never runtime-validated.
   Attach `npm test` output + `xbus doctor --json` to a `[Validation]` issue.
   *Labels: `good first issue`, `validation`, `platform: linux`, `help wanted`.*

2. **Run the test suite on macOS and report results.**
   Same as above on macOS (Intel and/or Apple Silicon — note which). We need to
   know whether the socket path, mode hardening, and the full suite pass on a real
   Mac. *Labels: `good first issue`, `validation`, `platform: macos`, `help wanted`.*

3. **Cross-user Windows boundary smoke test.**
   On a Windows box with two OS accounts, confirm a second user cannot read the
   data dir / DB / state file / secret (`icacls /inheritance:r` is applied) and
   cannot connect to the named pipe. Document the procedure and the result. This
   is the single biggest unverified security boundary.
   *Labels: `good first issue`, `validation`, `platform: windows`, `help wanted`, `area: transport`.*

4. **Document the manual PATH-integration steps for macOS/Linux.**
   The installer's PATH/shell-profile edit is gated/Windows-first; write the
   equivalent manual steps (`.zshrc` / `.bashrc`) to put `xbus`/`xclaude` on PATH
   on Unix, mirroring `docs/installation.md`. Docs-only.
   *Labels: `good first issue`, `docs`, `area: install`.*

5. **Add a `node --version` / `>=22.5` preflight check to a friendlier error.**
   If `node:sqlite` is unavailable (Node < 22.5), surface a single clear,
   actionable message from `xbus doctor` rather than a raw import error. Small,
   well-scoped, testable. *Labels: `good first issue`, `area: broker`.*

6. **Improve `xbus doctor` output for the "broker not reachable" case.**
   When the broker isn't running, `doctor` should distinguish "not started" from
   "started but unreachable" and suggest the exact next command (`xbus start`).
   Unit-testable against the existing doctor surface.
   *Labels: `good first issue`, `area: broker`.*

7. **Quickstart copy-paste audit on a clean machine.**
   Follow `docs/quickstart.md` verbatim on a fresh profile (use the isolated
   `XBUS_DATA_DIR` trial so nothing real is touched) and file doc fixes for any
   command, flag, or output that doesn't match reality. Docs-only, no code.
   *Labels: `good first issue`, `docs`.*

8. **Add an `xbus sessions --json` machine-readable variant (if absent).**
   The human table is documented; a body-free JSON form (connection / receive
   mode / readiness / queued / unacked per session) is useful for scripting and
   fits the existing body-free observability surface. Verify it doesn't already
   exist before starting. *Labels: `good first issue`, `area: mcp`.*

> Honesty guard: do not seed "good first issues" that require the maintainer's
> private environment (real install on the maintainer's machine, code signing,
> independent security audit). Those are roadmap items, **not** first issues.
