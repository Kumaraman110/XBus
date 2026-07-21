/**
 * BETA.10 (ADR 0036) — P1 fix regression: the MCP server registers its mcp component EAGERLY at the
 * client's `notifications/initialized`, NOT lazily on the first xbus_* tool call. This closes the
 * false-DEGRADED_HOOK_ONLY nag a reviewer + reliability lane reproduced: a healthy plugin-loaded
 * xclaude session whose first turn calls no tool previously had mcpEver=false at its first Stop →
 * a false "plugin did NOT load — run xclaude". With eager registration, ensureBroker (which does the
 * register_session) fires at `initialized`, so the mcp component is present before any Stop.
 *
 * Deterministic: ensureBroker + write are injected; no real socket/broker/tool call.
 */
import { describe, it, expect, vi } from 'vitest';
import { McpServer, type McpServerDeps } from '../../src/channel/mcp-server.js';

function deps(over: Partial<McpServerDeps> = {}): McpServerDeps {
  return {
    sessionId: 'sess-eager-1', instanceId: 'inst-1', projectId: 'proj-x', cwd: '/',
    endpoint: '\\\\.\\pipe\\xbus-eager-test',
    rootSecret: Buffer.alloc(32, 7),
    write: () => {},
    ensureBroker: async () => {},
    ...over,
  };
}

describe('MCP eager registration at notifications/initialized (P1 fix)', () => {
  it('handling notifications/initialized triggers ensureBroker (eager mcp registration), not just tool calls', async () => {
    const ensure = vi.fn(async () => {});
    const srv = new McpServer(deps({ ensureBroker: ensure }));
    await srv.handle({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);
    // A microtask/tick for the fire-and-forget void ensureBroker().catch(...) to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('is NON-BLOCKING + fail-open: a throwing ensureBroker at initialized does NOT reject handle() (init must never wedge)', async () => {
    const ensure = vi.fn(async () => { throw new Error('broker briefly unreachable'); });
    const srv = new McpServer(deps({ ensureBroker: ensure }));
    // handle() must resolve (not throw) even though the eager registration failed.
    await expect(srv.handle({ jsonrpc: '2.0', method: 'notifications/initialized' } as never)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(ensure).toHaveBeenCalledTimes(1); // attempted; the lazy tool-call path still retries later
  });

  it('initialize still returns the server handshake result (eager register does not alter the protocol reply)', async () => {
    const writes: string[] = [];
    const srv = new McpServer(deps({ write: (s: string) => { writes.push(s); } }));
    await srv.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } } as never);
    expect(writes.length).toBe(1);
    const reply = JSON.parse(writes[0]!) as { result?: { serverInfo?: { name?: string } } };
    expect(reply.result?.serverInfo?.name).toBe('xbus');
  });
});
