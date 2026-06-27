# Security

> **Internally reviewed and adversarially tested — NOT independently audited.**
> XBus is a Public Developer Preview. We are requesting external review.

## Threat model

XBus is **same-machine, same-user** software. The boundary it defends:

| Threat | Defended? | Mechanism |
|--------|-----------|-----------|
| Accidental cross-session access | ✅ | Authority bound to the authenticated connection (session+epoch+role); a session only reaches its own messages (ADR 0006). |
| Unrelated OS user reading the store / IPC | ✅ (where ACLs apply) | Data dir, DB, state file, secret restricted to the owner (`icacls /inheritance:r` on Windows; mode on Unix). |
| Forged / replayed / reordered / tampered IPC frames | ✅ | XBUS-STP: mutual auth + per-frame AES-256-GCM + sequence-based replay/reorder rejection. |
| A peer trying to inject privileged frames before auth | ✅ | No plaintext privileged fallback; pre-handshake frames are rejected; handshake-completion timeout. |
| Connect floods / slow-loris / oversized frames | ✅ | Connection cap, connect-rate token bucket, buffer-budget, handshake timeout (§3). |
| Malware running as your own privileged user | ❌ | XBus is **not** a sandbox against yourself. |
| Cross-user attack on **Windows** | ⚠️ unverified | The same-user boundary is proven; cross-user is **not yet runtime-validated** (no second-account environment). |

## XBUS-STP (the secure transport)

The local IPC channel (Windows named pipe / Unix domain socket) is treated as an
**untrusted transport**, because on Windows a named pipe's DACL is not settable
from Node's `net` API (ADR 0010). Rather than depend on a separate .NET proxy,
XBus puts a cryptographic boundary in pure Node:

- A per-installation **256-bit root secret** stored in the ACL-restricted data dir.
- **Mutual nonce challenge-response** binding both parties to installation membership.
- A **transcript-bound key schedule** (HKDF-SHA256) deriving per-connection keys.
- **Per-frame AES-256-GCM** (96-bit nonce, 128-bit tag) with per-frame AAD
  (version, connId, direction, sequence, ciphertext length).
- **Replay / reorder rejection** via monotonic sequence + AAD binding.
- **Uniform `AUTH_FAILED`** — no oracle distinguishing bad-secret from bad-format.
- **No forward secrecy** — justified against the same-user threat model (an
  attacker who can read the root secret already has your privileges).

Full wire format: [secure-transport-spec.md](secure-transport-spec.md). The
privileged-frame inventory (which frames require which role) is in
[privileged-frame-inventory.md](privileged-frame-inventory.md).

## Authority, not bearer tokens

The model never holds a secret capability. When a message is injected, the model
sees a **non-secret `injection_id`**. `xbus_ack` / `xbus_reply` are authorized by
the authenticated connection's identity, so a leaked `injection_id` in a
transcript grants nothing from another session (ADR 0006). One-time receipts in
the ledger prevent replay.

## What we ask reviewers to look at

1. The XBUS-STP spec + key schedule + AAD construction.
2. The same-user threat model and the no-forward-secrecy justification.
3. The Windows IPC decision (crypto boundary vs OS ACL / .NET proxy).
4. The authority model (connection-bound, non-bearer) and the receipt ledger.

Report issues per [SECURITY.md](../SECURITY.md) — private disclosure, not a public
issue.
