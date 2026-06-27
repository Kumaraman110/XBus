/**
 * §6 — realistic dogfood scenario over XBus (NOT a nonce echo).
 *
 * Two real Claude-Code-style sessions collaborate over the SECURE transport on a
 * substantive task: reviewing an Orders API v2 contract for breaking changes
 * against the v1 baseline.
 *
 *   architect  → sends the v2 contract (+ a pointer to the v1 baseline) as a
 *                requires_ack / requires_reply request.
 *   reviewer   → pulls it from its inbox, runs the REAL breaking-change analyzer
 *                (contract-diff.ts) over the two fixtures, acks acceptance, then
 *                replies with a structured findings report.
 *   architect  → receives the correlated reply and reads the verdict.
 *
 * This drives the full product surface — register, alias, secure send, inbox
 * view (§1 body-once), ack, correlated reply — with real content. The synthetic
 * contract fixtures live in examples/contract-review/; the human-readable
 * transcript is written to a temp dir (never committed into the repo tree).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { doHello } from '../../src/ipc/hello.js';
import { ComponentRole } from '../../src/identity/components.js';
import { diffContracts, summarize, type Finding } from '../../examples/contract-review/contract-diff.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.resolve(HERE, '../../examples/contract-review');
const FIXTURES = path.join(EXAMPLE, 'fixtures');

let dataDir: string;
let broker: RunningBroker;
const clients: IpcClient[] = [];

async function session(sessionId: string, alias: string): Promise<IpcClient> {
  const c = new IpcClient(broker.endpoint, { rootSecret: broker.rootSecret!, helloIdentity: { claimedRole: 'mcp', claimedSessionId: sessionId } });
  clients.push(c);
  await c.connect();
  await doHello(c, ComponentRole.MCP);
  await c.request('register_session', { sessionId, instanceId: `inst-${alias}`, processId: process.pid, projectId: 'orders-svc', cwd: process.cwd(), receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: ComponentRole.MCP });
  await c.request('signal_readiness', { ackAvailable: true, versionOk: true });
  await c.request('register_alias', { alias });
  return c;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-dogfood-'));
  broker = await startBrokerHost({ dataDir, reaperIntervalMs: 0 });
});
afterEach(async () => {
  for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
  clients.length = 0;
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('§6 dogfood: API contract breaking-change review over XBus', () => {
  it('architect → reviewer analyzes a real contract diff and replies with structured findings', async () => {
    const v1 = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'orders-api-v1.json'), 'utf8'));
    const v2 = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'orders-api-v2.json'), 'utf8'));

    const architect = await session('a000d09f-0000-4000-8000-00000000a001', 'architect');
    const reviewer = await session('b000d09f-0000-4000-8000-00000000b001', 'reviewer');

    // 1) architect sends the v2 contract as a review request (real payload, not a nonce).
    const requestText = [
      'Please review Orders API v2.0.0 for breaking changes against v1.4.0 before we ship it.',
      'The v2 contract is attached below; the v1 baseline is in the repo at',
      'examples/contract-review/fixtures/orders-api-v1.json.',
      '',
      '```json',
      JSON.stringify(v2, null, 2),
      '```',
    ].join('\n');
    const send = await architect.request('send_message', { to: 'reviewer', text: requestText, kind: 'request', requiresAck: true, requiresReply: true });
    expect(send.frameType).toBe('send_message_ack');
    const messageId = (send.payload as { messageId: string }).messageId;
    const correlationId = (send.payload as { correlationId: string }).correlationId;

    // 2) reviewer pulls its inbox — §1 guarantees the body appears exactly once.
    const inbox = (await reviewer.request('inbox', { limit: 10 })).payload as { messages: Array<{ messageId: string; text?: string; bodyIncluded: boolean; injectionId: string }> };
    expect(inbox.messages).toHaveLength(1);
    const item = inbox.messages[0]!;
    expect(item.bodyIncluded).toBe(true);
    expect(item.text).toContain('Orders API v2.0.0');
    // The reviewer extracts the attached contract from the request body it received.
    const fence = item.text!.match(/```json\n([\s\S]*?)\n```/);
    expect(fence).not.toBeNull();
    const receivedV2 = JSON.parse(fence![1]!);

    // 3) reviewer does the REAL work: breaking-change analysis.
    const findings: Finding[] = diffContracts(v1, receivedV2);
    const sum = summarize(findings);
    // Sanity: the fixtures contain genuine breaking changes.
    expect(sum.breaking).toBeGreaterThan(0);
    expect(sum.verdict).toBe('block');
    // Spot-check that specific, real breaking changes were detected.
    const kinds = new Set(findings.map((f) => f.kind));
    expect(kinds.has('field_removed')).toBe(true);        // Order.status->state, total_cents->total (renamed = removed+added)
    expect(kinds.has('new_required_field')).toBe(true);   // OrderCreate.idempotency_key + total (new + required)
    expect([...kinds]).toContain('param_became_required'); // listOrders ?limit optional -> required

    // 4) reviewer acks acceptance, then replies with the structured report.
    const ack = await reviewer.request('ack_message', { messageId, status: 'accepted', injectionId: item.injectionId });
    expect((ack.payload as { state: string }).state).toBe('accepted');

    const report = {
      contract: 'Orders API v1.4.0 -> v2.0.0',
      verdict: sum.verdict,
      counts: { breaking: sum.breaking, warning: sum.warning, info: sum.info },
      findings: findings.map((f) => ({ severity: f.severity, kind: f.kind, path: f.path, detail: f.detail })),
      recommendation: 'BLOCK the v2 cut as a minor bump; these are breaking and require a major version + migration guide.',
    };
    const reply = await reviewer.request('reply_message', { messageId, text: JSON.stringify(report, null, 2), outcome: 'completed', injectionId: item.injectionId });
    expect(reply.frameType).toBe('reply_message_ack');

    // 5) architect receives the correlated reply.
    const aInbox = (await architect.request('inbox', { limit: 10 })).payload as { messages: Array<{ text?: string; kind: string; correlationId: string; causationId: string | null; bodyIncluded: boolean }> };
    expect(aInbox.messages).toHaveLength(1);
    const replyMsg = aInbox.messages[0]!;
    expect(replyMsg.kind).toBe('reply');
    expect(replyMsg.correlationId).toBe(correlationId);
    expect(replyMsg.causationId).toBe(messageId);
    expect(replyMsg.bodyIncluded).toBe(true);
    const parsed = JSON.parse(replyMsg.text!);
    expect(parsed.verdict).toBe('block');
    expect(parsed.counts.breaking).toBe(sum.breaking);

    // 6) Write the human-readable transcript as evidence (deterministic content).
    const transcript = [
      '# §6 Dogfood transcript — Orders API contract review over XBus',
      '',
      'A real two-session collaboration over the secure transport. No nonce — the',
      'reviewer session performed an actual OpenAPI breaking-change analysis on the',
      'contract it received, and replied with a structured report.',
      '',
      '## 1. architect → reviewer (request, requires_ack + requires_reply)',
      '',
      '> Please review Orders API v2.0.0 for breaking changes against v1.4.0 before we ship it.',
      `> (v2 contract attached, ${JSON.stringify(v2).length} bytes; v1 baseline referenced by repo path)`,
      '',
      `- message id: \`${messageId}\``,
      `- correlation id: \`${correlationId}\``,
      '- delivery: durable, queued_until_checkpoint, then injected at the reviewer’s inbox read',
      '',
      '## 2. reviewer analysis (the real work)',
      '',
      `Verdict: **${sum.verdict.toUpperCase()}** — ${sum.breaking} breaking, ${sum.warning} warning, ${sum.info} info.`,
      '',
      '| Severity | Kind | Path | Detail |',
      '|----------|------|------|--------|',
      ...findings.map((f) => `| ${f.severity} | ${f.kind} | \`${f.path}\` | ${f.detail} |`),
      '',
      '## 3. reviewer → architect (correlated reply, outcome=completed)',
      '',
      '```json',
      JSON.stringify(report, null, 2),
      '```',
      '',
      '## 4. correlation proof',
      '',
      `- reply.kind = \`reply\``,
      `- reply.correlationId = \`${replyMsg.correlationId}\` (== original correlation id)`,
      `- reply.causationId = \`${replyMsg.causationId}\` (== original message id)`,
      '',
      '## What this exercised',
      '',
      '- secure register + alias + signal_readiness (§2) over XBUS-STP',
      '- a real multi-KB request body delivered intact and shown exactly once (§1)',
      '- ack acceptance + a structured, correlated reply',
      '- genuine domain work (breaking-change detection) on the received content',
    ].join('\n');
    // Write the human-readable transcript to a temp dir (never into the repo tree).
    const transcriptPath = path.join(dataDir, 'contract-review-transcript.md');
    fs.writeFileSync(transcriptPath, transcript + '\n');
    expect(fs.existsSync(transcriptPath)).toBe(true);
  });
});
