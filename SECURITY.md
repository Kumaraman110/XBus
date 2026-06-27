# Security Policy

## Status

XBus is a **Public Developer Preview**. Its custom secure transport
(XBUS-STP) is **internally reviewed and adversarially tested, but NOT
independently audited.** We are actively requesting external review of the
protocol spec, threat model, and the Windows IPC design decision.

## Threat model (summary)

XBus is **same-machine, same-user** software. It defends against:

- **Accidental cross-session access** — a session only reaches messages addressed
  to it; authority is bound to the authenticated connection (ADR 0006).
- **Unrelated OS users** — on platforms where it applies, the data directory and
  IPC are restricted to the owning user (Windows ACLs via `icacls`; Unix mode).
- **Forged / replayed / tampered IPC** — every broker frame is authenticated and
  encrypted under XBUS-STP (mutual installation-membership auth, per-frame
  AES-256-GCM with replay/reorder rejection).

It explicitly does **NOT** defend against:

- Malware running as your own fully-privileged OS user (XBus is not a sandbox).
- Cross-user attacks on Windows are **not yet runtime-validated** (no second-account
  test environment was available); treat that boundary as unverified.

See [docs/security.md](docs/security.md) and
[docs/secure-transport-spec.md](docs/secure-transport-spec.md) for the full model.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Instead, open a [GitHub Security Advisory](../../security/advisories/new) (private
disclosure) on this repository, or contact the maintainers through the private
channel listed on the project page. Include:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof-of-concept if possible),
- the affected version / commit.

We aim to acknowledge a report within **5 business days** and to provide a
remediation timeline after triage. Because this is a preview, there is no formal
SLA yet; we will be transparent about status.

## Scope

In scope: the broker, the secure transport, identity/authority, the MCP tool
surface, the hook, packaging, and any way a peer message or a local attacker
could escalate beyond the model above.

Out of scope: attacks requiring privileges XBus already assumes the attacker
lacks (e.g. another OS user where ACLs are not yet validated is a *known* gap,
not a new finding), and anything dependent on a compromised same-user account.
