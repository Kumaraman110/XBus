/**
 * XBus MCP server — the per-session process Claude Code spawns. Hand-rolled
 * JSON-RPC 2.0 over stdio (zero deps, same approach proven in the Phase-0
 * spike). Exposes the XBus MCP tools, backed by an IpcClient to the broker.
 *
 * Identity: sessionId from CLAUDE_CODE_SESSION_ID (hard-fail if absent). The
 * MCP server registers with the broker; the broker derives sender identity from
 * the authenticated connection — tool callers can NEVER set it.
 *
 * Receive mode: hook_checkpoint. This server does NOT push; the companion hook
 * pulls pending messages at a checkpoint. xbus_inbox lets the model read its
 * own pending queue on demand.
 */
import { IpcClient } from '../ipc/client.js';
import { XBUS_VERSION } from '../protocol/version.js';
import { buildChannelInstructions } from './instructions.js';
import { doHello } from '../ipc/hello.js';
import { ComponentRole } from '../identity/components.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

export interface McpServerDeps {
  sessionId: string;
  instanceId: string;
  projectId: string;
  cwd: string;
  endpoint: string;
  /** Installation root secret for the XBUS-STP secure transport. */
  rootSecret: Buffer;
  write: (line: string) => void;
  log?: (line: string) => void;
}

const TOOLS = [
  {
    name: 'xbus_send',
    description: 'Send a message to another Claude session by alias or session id. Returns the message id and delivery state.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient alias, project/alias, or exact session id.' },
        text: { type: 'string', description: 'Message text (untrusted peer content to the receiver).' },
        kind: { type: 'string', enum: ['request', 'event'] },
        requiresAck: { type: 'boolean' },
        requiresReply: { type: 'boolean' },
        ttlSeconds: { type: 'number' },
        idempotencyKey: { type: 'string' },
        metadata: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'xbus_ack',
    description: 'Acknowledge a received XBus message. status "accepted" or "rejected". Call BEFORE substantial work for requires_ack messages. Pass the injection_id shown in the message header.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        status: { type: 'string', enum: ['accepted', 'rejected'] },
        note: { type: 'string' },
        injectionId: { type: 'string', description: 'The injection_id shown in the delivered message header (non-secret reference).' },
      },
      required: ['messageId', 'status'],
    },
  },
  {
    name: 'xbus_reply',
    description: 'Reply to a received XBus message. Correlation + causation are preserved automatically. Pass the injection_id shown in the message header.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        text: { type: 'string' },
        outcome: { type: 'string', enum: ['completed', 'failed', 'partial'] },
        idempotencyKey: { type: 'string' },
        metadata: { type: 'object', additionalProperties: { type: 'string' } },
        injectionId: { type: 'string', description: 'The injection_id shown in the delivered message header (non-secret reference).' },
      },
      required: ['messageId', 'text', 'outcome'],
    },
  },
  {
    name: 'xbus_inbox',
    description: 'List XBus messages for THIS session. New messages include the full body once; an already-shown message returns metadata with bodyIncluded:false (it is NOT repeated). Use xbus_redeliver to re-show a body on purpose.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'xbus_redeliver',
    description: 'Explicitly re-present the full body of an already-injected message (e.g. it scrolled out of context). WARNING: the request may then be processed twice. Use only when intentional.',
    inputSchema: { type: 'object', properties: { messageId: { type: 'string' }, reason: { type: 'string' } }, required: ['messageId'] },
  },
  {
    name: 'xbus_sessions',
    description: 'List discoverable XBus sessions and their receive modes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'xbus_register',
    description: 'Register an alias for THIS session so other sessions can address it.',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' } }, required: ['alias'] },
  },
  {
    name: 'xbus_status',
    description: 'Report XBus connection + session status for this session.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export class McpServer {
  private client: IpcClient;
  private connected = false;

  constructor(private readonly deps: McpServerDeps) {
    this.client = new IpcClient(deps.endpoint, { rootSecret: deps.rootSecret, helloIdentity: { claimedRole: 'mcp', claimedSessionId: deps.sessionId } });
  }

  private send(obj: unknown): void {
    this.deps.write(JSON.stringify(obj) + '\n');
  }

  private async ensureBroker(): Promise<void> {
    if (this.connected) return;
    // Fresh client each (re)connect — a long-lived MCP server outlives broker
    // restarts, so the prior socket may be dead. onClose flips `connected` so the
    // NEXT tool call transparently reconnects + re-registers (joins current epoch).
    this.client = new IpcClient(this.deps.endpoint, { rootSecret: this.deps.rootSecret, helloIdentity: { claimedRole: 'mcp', claimedSessionId: this.deps.sessionId } });
    this.client.onClose(() => { this.connected = false; });
    await this.client.connect();
    await doHello(this.client, ComponentRole.MCP);
    await this.client.request('register_session', {
      sessionId: this.deps.sessionId,
      instanceId: this.deps.instanceId,
      processId: process.pid,
      projectId: this.deps.projectId,
      cwd: this.deps.cwd,
      receiveMode: 'hook_checkpoint',
      capabilities: ['ack', 'reply', 'inbox'],
      role: ComponentRole.MCP,
    });
    // §2: the MCP server is the component that can ack/reply, so once it has
    // registered the session can take delivery. Signal readiness explicitly with
    // concrete capability hints — the broker derives ready_checkpoint (Bedrock).
    await this.client.request('signal_readiness', { ackAvailable: true, versionOk: true });
    this.connected = true;
  }

  async handle(req: JsonRpcRequest): Promise<void> {
    const { method, id } = req;
    if (method === 'initialize') {
      this.send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: (req.params as { protocolVersion?: string })?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'xbus', version: XBUS_VERSION },
          instructions: buildChannelInstructions(),
        },
      });
      return;
    }
    if (method === 'notifications/initialized') return;
    if (method === 'tools/list') {
      this.send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'ping') {
      this.send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/call') {
      await this.toolCall(req);
      return;
    }
    if (id !== undefined && id !== null) {
      this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  private async toolCall(req: JsonRpcRequest): Promise<void> {
    const id = req.id;
    const name = req.params?.name;
    const args = req.params?.arguments ?? {};
    try {
      let result: unknown;
      try {
        await this.ensureBroker();
        result = await this.dispatch(name ?? '', args);
      } catch (firstErr) {
        // Broker-unavailable (e.g. it restarted under a long-lived session) ->
        // force a reconnect + ONE retry. Application errors are not retried.
        const code = (firstErr as { code?: string }).code;
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        const transient = code === 'XBUS_BROKER_UNAVAILABLE' || /not connected|connection closed|timed out|ECONNRESET|EPIPE/i.test(msg);
        if (!transient) throw firstErr;
        this.connected = false;
        try { this.client.close(); } catch { /* ignore */ }
        await this.ensureBroker();
        result = await this.dispatch(name ?? '', args);
      }
      this.send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Tool-level error: surface as a tool result (isError) so the model sees it.
      this.send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: msg }) }] } });
    }
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'xbus_send': {
        const f = await this.client.request('send_message', args);
        return this.unwrap(f);
      }
      case 'xbus_ack': {
        const f = await this.client.request('ack_message', args);
        return this.unwrap(f);
      }
      case 'xbus_reply': {
        const f = await this.client.request('reply_message', args);
        return this.unwrap(f);
      }
      case 'xbus_inbox': {
        const f = await this.client.request('inbox', args);
        return this.unwrap(f);
      }
      case 'xbus_redeliver': {
        const f = await this.client.request('redeliver', args);
        return this.unwrap(f);
      }
      case 'xbus_sessions': {
        const f = await this.client.request('list_sessions', args);
        return this.unwrap(f);
      }
      case 'xbus_register': {
        const f = await this.client.request('register_alias', args);
        return this.unwrap(f);
      }
      case 'xbus_status': {
        const f = await this.client.request('get_status', args);
        return this.unwrap(f);
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  private unwrap(frame: { frameType: string; payload: unknown }): unknown {
    if (frame.frameType === 'error') {
      const p = frame.payload as { code: string; message: string };
      throw new Error(`${p.code}: ${p.message}`);
    }
    return frame.payload;
  }

  start(stdin: NodeJS.ReadableStream): void {
    let buf = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let req: JsonRpcRequest;
        try {
          req = JSON.parse(line) as JsonRpcRequest;
        } catch {
          continue;
        }
        void this.handle(req);
      }
    });
  }
}
