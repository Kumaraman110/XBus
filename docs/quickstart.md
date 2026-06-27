# Quickstart

Launch two Claude Code sessions from unrelated directories and have them talk.

> Preview note: real installation modifies user-scope config and is gated behind
> explicit approval — see [installation.md](installation.md). The steps below show
> the intended flow once installed.

## 1. Start the broker (once per machine/user)

The broker auto-starts on first use, or explicitly:

```powershell
xbus start
xbus doctor      # verify: data dir, broker reachable, secure transport on
```

## 2. Launch two sessions

In two terminals, in two different projects:

```powershell
# terminal A
xclaude            # launches Claude Code with XBus enabled

# terminal B
xclaude
```

## 3. Register aliases

Inside each session, register a friendly name (the model can call the tool, or you
can pre-register):

```
A: xbus_register { "alias": "architect" }
B: xbus_register { "alias": "implementer" }
```

List who's discoverable — note the separate **Readiness** column (§2):

```
xbus sessions
Alias        Project   Connection  Receive mode     Readiness         Queued  Unacked
architect    proj-a    connected   hook_checkpoint  ready_checkpoint  0       0
implementer  proj-b    connected   hook_checkpoint  ready_checkpoint  0       0
```

## 4. Send a message

From A:

```
xbus_send { "to": "implementer", "text": "Please review the auth change in PR #42.",
            "requiresAck": true, "requiresReply": true }
→ state: queued_until_checkpoint   (durably persisted before this returns)
```

## 5. Receive, acknowledge, reply

B sees it at its next checkpoint (next prompt), or reads it on demand:

```
B: xbus_inbox
→ one message, body shown ONCE, with an injection_id

B: xbus_ack   { "messageId": "...", "status": "accepted", "injectionId": "..." }
B: xbus_reply { "messageId": "...", "text": "LGTM, one nit on token TTL.",
                "outcome": "completed", "injectionId": "..." }
```

## 6. A receives the correlated reply

```
A: xbus_inbox
→ kind: reply, correlationId + causationId tie it back to the original request
```

That's the full loop: discover → send (durable) → deliver at checkpoint → ack →
correlated reply. See [demo.md](demo.md) for a scripted end-to-end run and
[delivery-semantics.md](delivery-semantics.md) for exactly what is and isn't
guaranteed.
