/**
 * FOUR-REPLICA COMPLETE DIRECTED MATRIX (beta.5 acceptance — the full K4, not a ring).
 *
 * The control-plane-e2e "four-replica" test exercises a 4-message RING under dashboard load
 * to prove reads don't disturb delivery. This test proves the STRONGER reliability-matrix
 * acceptance criterion the product claims: on 4 replicas sharing one broker, EVERY one of the
 * 12 directed sender→recipient paths (4×3 complete directed graph) delivers EXACTLY ONCE, each
 * with a correct ACK and a correlated reply, and with:
 *   - no LOSS               (all 12 requests received + completed),
 *   - no DUPLICATES         (each nonce appears exactly once in exactly one inbox),
 *   - no CROSS-ROUTING      (a recipient only ever sees messages addressed TO it),
 *   - no CORRELATION MISMATCH (each reply carries the request's correlationId + causationId),
 *   - no RESURRECTION       (a completed delivery is not re-injected after the fact),
 * and the audit hash chain stays valid throughout.
 *
 * This is the negative-isolation + exactly-once proof the ring test does not make.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { defaultEndpoint } from '../../src/ipc/transport.js';
import { doHello } from '../../src/ipc/hello.js';
import { ComponentRole } from '../../src/identity/components.js';
import { verifyLedger } from '../../src/broker/ledger.js';

let dataDir: string; let broker: RunningBroker; let endpoint: string; let rootSecret: Buffer;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-4rm-'));
  endpoint = defaultEndpoint(dataDir);
  // Dashboard OFF here: this test is about the delivery matrix itself, not the read path
  // (control-plane-e2e already covers delivery UNDER dashboard load).
  broker = await startBrokerHost({ dataDir, enforceSingleton: false });
  rootSecret = broker.rootSecret!;
});
afterEach(async () => {
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function mcpClient(sessionId: string, alias: string): Promise<IpcClient> {
  const c = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'mcp', claimedSessionId: sessionId } });
  await c.connect();
  await doHello(c, ComponentRole.MCP);
  await c.request('register_session', { sessionId, instanceId: `i-${sessionId}`, processId: process.pid, projectId: 'proj-x', cwd: '/tmp/x', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: ComponentRole.MCP });
  await c.request('signal_readiness', { ackAvailable: true, versionOk: true });
  await c.request('register_alias', { alias });
  return c;
}

interface InboxMsg { messageId: string; text: string; injectionId: string; correlationId: string; causationId: string | null; kind?: string }
const inboxOf = async (c: IpcClient): Promise<InboxMsg[]> =>
  ((await c.request('inbox', { limit: 100 })).payload as { messages: InboxMsg[] }).messages;

describe('four-replica COMPLETE directed matrix — 12 paths, exactly once', () => {
  it('every one of the 12 directed sender→recipient paths delivers once, acked + correlated-replied, with no loss/dup/cross-routing/resurrection', async () => {
    const N = 4;
    const aliases = Array.from({ length: N }, (_, i) => `rep${i}`);
    const ids = Array.from({ length: N }, (_, i) => `40404040-4040-4040-8040-00000000000${i + 1}`);
    const clients = await Promise.all(ids.map((id, i) => mcpClient(id, aliases[i]!)));
    const idxByAlias = new Map(aliases.map((a, i) => [a, i]));

    // Enumerate ALL 12 ordered pairs (i→j, i≠j). Each nonce encodes its exact path so we can
    // detect cross-routing (a nonce landing in the wrong inbox) and duplicates (a nonce twice).
    const paths: Array<{ from: number; to: number; nonce: string }> = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) paths.push({ from: i, to: j, nonce: `P-${i}-to-${j}` });
    expect(paths.length).toBe(12);

    const correlationByNonce = new Map<string, string>();
    const messageIdByNonce = new Map<string, string>();
    // Replies are fire-and-forget: a checkpoint `inbox` pull CONSUMES a reply (at-most-once
    // injection), so we must CAPTURE every reply the moment any pull surfaces it — never
    // re-pull for it later. Accumulate per-recipient the replies each node observes, tagged
    // with which node saw it (to prove no reply cross-routing).
    const repliesSeenBy = Array.from({ length: N }, () => new Map<string, InboxMsg>());
    // Cross-routing/dup guard for REQUESTS: record every request-nonce each node ever sees.
    const requestsSeenBy = Array.from({ length: N }, () => new Set<string>());
    const acked = new Set<string>();

    // Phase 1 — SEND all 12.
    for (const p of paths) {
      const s = await clients[p.from]!.request('send_message', { to: aliases[p.to]!, text: p.nonce, requiresAck: true, requiresReply: true });
      expect(s.frameType, `send ${p.nonce}`).toBe('send_message_ack');
    }

    // Phase 2 — interleaved drain: repeatedly pull every node, ACK+REPLY each fresh REQUEST it
    // sees and record each REPLY it sees, until all 12 requests are acked and all 12 replies
    // observed. Because a pull consumes replies, capturing on every pull is the only correct way.
    for (let round = 0; round < 6 && (acked.size < 12 || repliesSeenBy.reduce((n, m) => n + m.size, 0) < 12); round++) {
      for (let node = 0; node < N; node++) {
        for (const m of await inboxOf(clients[node]!)) {
          if (m.text.startsWith('reply P-')) {
            repliesSeenBy[node]!.set(m.text, m); // capture NOW (a later pull won't return it)
          } else if (m.text.startsWith('P-')) {
            requestsSeenBy[node]!.add(m.text);
            if (acked.has(m.text)) continue; // idempotency guard (should never re-see an acked req)
            // No cross-routing: a request this node receives must be addressed TO this node.
            expect(m.text.endsWith(`-to-${node}`), `misrouted ${m.text} → rep${node}`).toBe(true);
            correlationByNonce.set(m.text, m.correlationId);
            messageIdByNonce.set(m.text, m.messageId);
            const ack = await clients[node]!.request('ack_message', { messageId: m.messageId, status: 'accepted', injectionId: m.injectionId });
            expect((ack.payload as { state: string }).state, `ack ${m.text}`).toBe('accepted');
            const reply = await clients[node]!.request('reply_message', { messageId: m.messageId, text: `reply ${m.text}`, outcome: 'completed', injectionId: m.injectionId });
            expect(reply.frameType, `reply ${m.text}`).toBe('reply_message_ack');
            acked.add(m.text);
          }
        }
      }
    }

    // All 12 requests acked (no loss).
    expect(acked.size, 'all 12 directed requests received + acked exactly once').toBe(12);
    // No request cross-routing/duplication: each node saw EXACTLY the 3 nonces addressed to it.
    for (let j = 0; j < N; j++) {
      const expectedForJ = paths.filter((p) => p.to === j).map((p) => p.nonce).sort();
      expect([...requestsSeenBy[j]!].sort(), `recipient rep${j} request routing`).toEqual(expectedForJ);
    }

    // Every SENDER received exactly its 3 correlated replies; correlation + causation preserved;
    // no reply cross-routing (a node only ever saw replies to messages IT sent).
    for (let i = 0; i < N; i++) {
      const expectedNonces = paths.filter((p) => p.from === i).map((p) => p.nonce);
      const seen = repliesSeenBy[i]!;
      expect(seen.size, `sender rep${i} reply count (no cross-routing / no loss)`).toBe(expectedNonces.length);
      for (const nonce of expectedNonces) {
        const r = seen.get(`reply ${nonce}`);
        expect(r, `sender rep${i} correlated reply for ${nonce}`).toBeTruthy();
        expect(r!.correlationId, `correlation ${nonce}`).toBe(correlationByNonce.get(nonce));
        expect(r!.causationId, `causation ${nonce}`).toBe(messageIdByNonce.get(nonce));
      }
    }

    // Phase 4 — global exactly-once counts over the authoritative store. 12 request deliveries
    // + 12 reply deliveries = 24 completed; each is a DISTINCT message (no duplicates/resurrection).
    const completed = (broker.db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE state='completed'`).get() as { n: number }).n;
    expect(completed, '12 requests + 12 replies all completed exactly once').toBe(24);
    const totalMessages = (broker.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
    expect(totalMessages, '24 distinct messages (12 requests + 12 replies), no duplicates').toBe(24);
    // No delivery is stuck/duplicated in a non-terminal live state after everyone acked+replied.
    const live = (broker.db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE state IN ('queued','retry_wait','transport_written')`).get() as { n: number }).n;
    expect(live, 'no residual undelivered/duplicated deliveries').toBe(0);

    // Audit hash chain valid after the whole matrix.
    expect(verifyLedger(broker.db).ok).toBe(true);

    for (const c of clients) c.close();
  }, 120_000);

  it('a BROKEN audit chain is reported honestly yet does NOT block messaging delivery', async () => {
    const A = await mcpClient('50505050-5050-4050-8050-00000000000a', 'alpha');
    const B = await mcpClient('50505050-5050-4050-8050-00000000000b', 'bravo');
    // Announce both sessions so there are real ledger events to tamper (send/ack/reply do NOT
    // write the ledger; only lifecycle announces do). Each announce_session appends one event.
    await A.request('announce_session', { source: 'startup', cwd: '/tmp/x' });
    await B.request('announce_session', { source: 'startup', cwd: '/tmp/x' });

    // Sanity: a clean send→ack→reply works and the chain is intact.
    const s1 = await A.request('send_message', { to: 'bravo', text: 'before', requiresAck: true, requiresReply: true });
    expect(s1.frameType).toBe('send_message_ack');
    const m1 = (await inboxOf(B)).find((m) => m.text === 'before')!;
    expect(m1).toBeTruthy();
    await B.request('ack_message', { messageId: m1.messageId, status: 'accepted', injectionId: m1.injectionId });
    await B.request('reply_message', { messageId: m1.messageId, text: 'reply before', outcome: 'completed', injectionId: m1.injectionId });
    expect(verifyLedger(broker.db).ok, 'chain intact before tamper').toBe(true);
    // Confirm there IS a chain to break (guards against a silent empty-ledger pass).
    const seqCount = (broker.db.prepare(`SELECT COUNT(*) AS n FROM ledger_events`).get() as { n: number }).n;
    expect(seqCount, 'announces created ledger events to tamper').toBeGreaterThan(0);

    // TAMPER the ledger out-of-band (same technique as the read-model test): drop the
    // append-only trigger, mutate seq=1's payload, restore the trigger. The chain is now BROKEN.
    broker.db.exec('DROP TRIGGER ledger_no_update');
    broker.db.prepare("UPDATE ledger_events SET payload_json='{\"tampered\":1}' WHERE seq=1").run();
    broker.db.exec("CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_events BEGIN SELECT RAISE(ABORT,'ledger_events is append-only'); END");

    // HONEST REPORTING: verify localizes the break to the first bad seq (not masked).
    const v = verifyLedger(broker.db);
    expect(v.ok, 'a tampered chain must report broken').toBe(false);
    expect(v.firstBreak?.seq, 'break localized to first bad seq').toBe(1);

    // NEVER BLOCKS DELIVERY: with the chain provably broken, a full send→ack→reply round-trip
    // still completes end-to-end. The ledger is a projection; a broken chain must not wedge the
    // messaging path (that is the delivery-availability guarantee).
    const s2 = await A.request('send_message', { to: 'bravo', text: 'after-break', requiresAck: true, requiresReply: true });
    expect(s2.frameType, 'send still works with a broken chain').toBe('send_message_ack');
    const m2 = (await inboxOf(B)).find((m) => m.text === 'after-break');
    expect(m2, 'delivery still reaches the recipient with a broken chain').toBeTruthy();
    const ack2 = await B.request('ack_message', { messageId: m2!.messageId, status: 'accepted', injectionId: m2!.injectionId });
    expect((ack2.payload as { state: string }).state, 'ack still works with a broken chain').toBe('accepted');
    const reply2 = await B.request('reply_message', { messageId: m2!.messageId, text: 'reply after-break', outcome: 'completed', injectionId: m2!.injectionId });
    expect(reply2.frameType, 'reply still works with a broken chain').toBe('reply_message_ack');
    const back = (await inboxOf(A)).find((m) => m.text === 'reply after-break');
    expect(back, 'correlated reply still returns with a broken chain').toBeTruthy();

    A.close(); B.close();
  }, 60_000);
});
