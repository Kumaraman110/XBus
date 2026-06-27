# Privileged-frame inventory (§4)

Every broker frame family + its secure-transport protection. All families flow
ONLY over XBUS-STP in production (no plaintext path — §3). Per family the gate
requires: (1) plaintext-pre-auth rejected, (2) wrong-secret rejected, (3) tamper
rejected, (4) replay rejected, (5) correct frame reaches authorization, (6)
authorization stays role/session/epoch scoped, (7) failure leaks no existence.

| Frame family | Auth needed | Role(s) | Tests |
|---|---|---|---|
| hello (STP handshake) | membership (L1) | any | secure-channel.test, no-plaintext-fallback |
| version negotiation (app hello) | post-STP | any | version-handshake.test (over STP) |
| register_session | L1 + binds L2/L3 | any role | component-authority, split-brain |
| heartbeat | L1 | any registered | (covered by deliverFrame path) |
| send | L1+L2+L4 | mcp/cli/admin | privileged-frames.test |
| checkpoint_pull_hook | L1+L2+L4 | hook only | component-authority (cross-session/role) |
| inbox | L1+L2+L4 | mcp/bounded | privileged-frames.test |
| ack_message | L1+L2+L3+L4 | mcp + injection | component-authority (INJECTION_NOT_FOUND, leaked-id) |
| reply_message | L1+L2+L3+L4 | mcp + injection | injection-ledger, deadletter-cancel |
| list_sessions | L1+L4 | admin/safe | no-plaintext-fallback (pre-auth no disclosure) |
| get_metrics | L1+L4 | admin | metrics-no-leak (body-free + role-gated; §1) |
| get_status | L1 | any | privileged-frames.test |
| set_control (pause/resume/dnd) | L1+L2 | self | scheduling-states |
| process_next | L1+L2+L4 | self | scheduling-states |
| block_peer (block/unblock) | L1+L2 | owner | scheduling-states |
| (cancellation) | L1+L2 | sender | deadletter-cancel |
| (takeover via register supersede) | L1 + proven supersede | mcp | split-brain |
| shutdown | L1+L4 | admin + instanceId | broker-shutdown |
| (dead-letter list/inspect/retry/discard) | L1+admin | admin | deadletter-cancel |
| (secret rotation) | L1+admin | admin | secure-channel rotation |

The protection for families 1-7 (plaintext-rejected / wrong-secret / tamper /
replay / correct-reaches-auth / scoped / no-leak) is exercised by
tests/security/privileged-frames.test.ts which drives a representative frame from
each family group through the secure transport and the four rejection vectors.
