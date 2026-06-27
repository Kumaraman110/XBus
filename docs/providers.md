# Providers & delivery modes

How a message reaches the receiving model depends on the Claude Code provider and
the transport available to it.

## Delivery modes

| Mode | How it delivers | Idle wake? |
|------|-----------------|-----------|
| `hook_checkpoint` | A hook injects queued messages at the receiver's next **lifecycle checkpoint** (e.g. the next user prompt / Stop). | No — a fully idle session receives at its next activity. |
| `live` *(future)* | A push transport delivers between turns without waiting for a checkpoint. | Yes, where the transport supports it. |

## Provider matrix

| Provider | Channels available? | XBus delivery | Notes |
|----------|--------------------|---------------|-------|
| **Amazon Bedrock** (`CLAUDE_CODE_USE_BEDROCK=1`) | ❌ Channels unavailable | `hook_checkpoint` | The primary, validated configuration. **Idle-wake is unsupported**; automatic Stop-continuation is **off by default**. Normal readiness = `ready_checkpoint`. |
| **claude.ai / Console API key** | ✅ Channels work | Channel transport (first-class, contract-tested) where enabled; otherwise `hook_checkpoint` | Live Channel delivery is supported only where Channels actually work; labeled by provider. |

## Why checkpoint delivery on Bedrock

Claude Code Channels — the native idle-wake mechanism — are not available on
Bedrock. Rather than block, XBus delivers via a **checkpoint hook**: the message
is durably queued and injected the next time the receiving session reaches a
supported checkpoint. This checkpoint-delivery path is exercised end to end by
the [e2e tests](../tests/e2e/), but it means:

- A session that is completely idle is **not** woken; it receives at its next prompt.
- The sender is told the honest state (`queued_until_checkpoint`), not "delivered".

## Readiness interaction (§2)

A recipient must be **ready** before XBus injects a request. On Bedrock the normal
ready state is `ready_checkpoint`. A session still `initializing` (e.g. mid-resume)
holds the message durably and the sender sees `queued_receiver_initializing` — no
request is injected that the receiver can't yet acknowledge. See
[delivery-semantics.md](delivery-semantics.md).
