# Security: adapter threat model (STRIDE)

> **Status: DESIGN_COMPLETE (planning).** Canonical plan:
> [`docs/roadmap/universal-xbus.md`](../roadmap/universal-xbus.md) §10. Baseline
> `v0.1.0-beta.2` / `69b191f` untouched.

## Trust rules (invariants every adapter preserves)

1. A peer is **always untrusted** — data, never instruction; grants no human
   authority/identity/permission/policy change.
2. Adapters **cannot grant human authority**; capability grants can only **narrow** the
   `components.ts` MATRIX, never widen.
3. **Provider credentials stay with the provider runtime** — no proxying through XBus.
4. **Authority is bound to the authenticated connection, not the payload** (`daemon.ts`).
5. Logs are **metadata-only, content-free, path-free** (`observability/*`).
6. Adapter packages are **checksum-covered + allowlisted, not auto-loaded**.
7. The **remote bridge is off by default** with a separate threat model.
8. **Same-user malicious process and cross-user access are outside the current local
   boundary** (`acl.ts` defends against *other* OS users) — they need separate OS-level
   validation.

## Assets

A1 broker authority/MATRIX · A2 durable store · A3 root secret · A4 untrusted peer
content · A5 session identity · A6 the privileged hook pull.

## Trust boundaries

TB1 peer↔broker · TB2 adapter↔SDK↔core · TB3 host-process↔adapter (`resolveIdentity`) ·
TB4 same-user-process↔XBus (out of boundary).

## STRIDE mitigation table

| # | Threat | STRIDE | Mitigation | Status |
|---|---|---|---|---|
| T1 | Malicious peer agent | E-of-P, Repud. | fence + fail-closed MATRIX + authority-from-connection | **HAVE** |
| T2 | Malicious message body (forged fence, bidi/zw) | Tamper, E-of-P | marker-neutralization + bidi/zw stripping + per-injection nonce | **HAVE** |
| T3 | Malicious adapter package | Tamper, E-of-P | checksum + allowlist, not auto-loaded; narrow-only grants | **NEW** |
| T4 | Compromised IDE host | Spoof, E-of-P | host identity re-verified by broker authz; cannot widen MATRIX/forge connection authority | **PARTIAL** |
| T5 | Credential leakage | Info-Disc. | no cred proxying; root secret never logged; metadata-only logs; `claude`/`xbus` denylist | **HAVE** |
| T6 | Command injection (launcher) | E-of-P | arg-array exec, no shell interpolation of peer/identity data | **PARTIAL** |
| T7 | Path injection | Tamper | fixed `secretPath` join; no peer-influenced path | **HAVE** |
| T8 | Symlink/reparse | Tamper, E-of-P | `assertNotReparse` (`acl.ts`) | **HAVE** |
| T9 | Stale process | Spoof, DoS | connection-drop revokes authority; reaper + epoch; secret rotation | **HAVE** |
| T10 | Session hijacking | Spoof, E-of-P | authority from connection; id/role/epoch bound into STP transcript | **HAVE** |
| T11 | Capability spoofing | Spoof, E-of-P | grants advisory + narrow-only; `assertAllowed` sole authority, fail-closed | **HAVE+NEW** |
| T12 | Replay / reorder | Tamper, Repud. | per-direction monotonic seq + IV-counter + GCM tag (`secure-channel.ts`) | **HAVE** |
| T13 | Cross-user access | E-of-P, Info-Disc. | data dir + secret + pipe restricted to user (+SYSTEM) + reparse guard | **HAVE (file layer)** |
| T14 | Remote-bridge exposure | E-of-P, Info-Disc. | bridge off by default; local-transport assumption | **NEW + DEFERRED** |
| T15 | Dependency compromise | Tamper | pinned `node:crypto` only; lockfile; checksum/allowlist regime | **PARTIAL** |

**Coverage:** 8 fully HAVE (+T13 file layer); 4 PARTIAL (T4/T6/T11/T15); 2 NEW/DEFERRED
(T3, T14). The hostile-host path (T4) and live anti-loop touch the §15 R1–R4 gate, which
is **unproven beyond Tier 3 `ready_checkpoint` on Bedrock**.
