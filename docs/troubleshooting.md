# Troubleshooting

Start with:

```
xbus doctor
```

It checks the data directory + ACLs, broker reachability, the secure transport,
and schema version, and prints an actionable line per check.

It also reports this process's full build identity (ADR 0011): the `this_build`
check shows the exact `buildId` (`xbus-<version>-<commit>`), `productVersion`,
`sourceCommit`, and the stable `compatibilityId`. With `--json`, `doctor` adds
`installedArtifactManifestSha256` (the exact installed-artifact id), `brokerExactBuild`
(the broker's exact build, learned over the authenticated channel), and `mixedBuilds`
— `true` when the client and broker are running different exact builds (even if they
are otherwise compatible). A `mixedBuilds: true` is a hint to restart the broker on
the newer build if behaviour looks inconsistent.

## Common situations

### "Broker not reachable" / messages stay queued

- The broker may not be running: `xbus start`, then `xbus doctor`.
- If `doctor` says the data dir is fine but no broker answers, a previous broker
  may have exited uncleanly; starting again acquires the singleton (a stale state
  file is non-blocking).

### A message I sent is `queued_receiver_initializing`

The recipient session has registered but hasn't signalled readiness yet (§2). This
is expected briefly during startup/resume. The message is durably queued and will
deliver once the recipient is `ready_checkpoint`. Check `xbus sessions` — the
**Readiness** column shows the recipient's state.

### A message is `queued_until_checkpoint` and never seems to arrive

On Bedrock, delivery happens at the receiver's **next checkpoint** (next prompt) —
idle sessions are not woken (see [providers.md](providers.md)). Have the receiving
session take a turn (submit any prompt) and it will inject pending messages.

### "I didn't see the message body, just metadata"

That's by design (§1). The body is shown **once**. A recovery `xbus_inbox` returns
`bodyIncluded:false` so the model's context isn't silently duplicated. If you
genuinely need to re-see it, use `xbus_redeliver` (it warns that the request may be
processed twice).

### `SESSION_ALREADY_ACTIVE` when launching

Another live owner already holds this session (split-brain guard, ADR 0008). Use a
fork, close the existing owner, or run an explicit `xbus takeover <session>`.

### "database schema is newer than this XBus build"

You're running an **older** XBus against a profile an upgraded build already
migrated. Upgrade XBus to match (or restore a compatible data dir). This is the
downgrade guard failing closed on purpose (§8).

### "migration checksum mismatch"

The recorded migration text differs from this build's. This usually means a
partially-applied or tampered store. Back up and inspect the data dir; do not
force past it.

### Reset everything

```powershell
xbus stop
Remove-Item -Recurse -Force $env:USERPROFILE\.claude\xbus   # or your XBUS_DATA_DIR
```

A fresh start re-creates the profile cleanly.

## Filing a bug

Include `xbus doctor` output (it contains no secrets or message bodies), your
Node version, OS, and provider (Bedrock / claude.ai). Security issues: see
[SECURITY.md](../SECURITY.md) (private disclosure).
