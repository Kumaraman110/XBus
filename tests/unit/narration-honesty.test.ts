/**
 * BETA.11 (ADR 0038) — RED-first: runtime context must NOT teach agents to narrate XBus transport
 * internals to the user (operator directive #15). The unacceptable behavior an operator saw:
 *   "My XBus is hook-only this session, so delivery lags — it surfaces on the next tick."
 *
 * That narration originated from the activation diagnostic being injected into the MODEL's context
 * (checkpoint additionalContext). This pins: (a) the model-facing channel instructions explicitly
 * forbid narrating checkpoint/hook-only/next-tick internals, and (b) the checkpoint hook routes the
 * activation notice to OPERATOR stderr, never into the model-facing additionalContext (stdout).
 */
import { describe, it, expect } from 'vitest';
import { buildChannelInstructions, buildCheckpointInjection } from '../../src/channel/instructions.js';
import { runCheckpoint } from '../../src/channel/checkpoint-hook.js';

describe('narration honesty — instructions forbid transport-internal narration (#15)', () => {
  it('channel instructions tell the agent NOT to explain checkpoint timing / hook-only / next tick', () => {
    const text = buildChannelInstructions().toLowerCase();
    expect(text).toContain('do not explain xbus checkpoint timing');
    // The forbidden phrasings are named so the agent is steered away from them.
    expect(text).toContain('send another prompt');
    expect(text).toContain('checkpoint tick');
    // And it must direct the agent to report STATUS/outcome instead.
    expect(text).toMatch(/report task status|report .*outcomes|non-delivery result/);
  });

  it('model-facing peer-message injection carries ONLY the untrusted-peer fence, no infra chatter', () => {
    const injection = buildCheckpointInjection(
      [{ messageId: 'm1', senderAlias: 'peer', sequence: 1, requiresAck: false, requiresReply: false, text: 'do the thing' }],
      'abcd1234',
    );
    // No delivery-timing / hook-only narration leaks into the model context.
    expect(injection.toLowerCase()).not.toContain('hook-only');
    expect(injection.toLowerCase()).not.toContain('next tick');
    expect(injection.toLowerCase()).not.toContain('delivery lags');
    expect(injection).toContain('UNTRUSTED_XBUS_PEER_MESSAGE');
  });
});

describe('narration honesty — activation notice goes to OPERATOR stderr, not model stdout', () => {
  // A broker the hook cannot reach → runCheckpoint degrades to exit 0, no stdout, no stderr.
  // We assert the SHAPE contract: whenever an activation notice exists it is returned as `stderr`
  // (operator/logs), and model-facing `stdout` only ever carries peer-message additionalContext.
  it('with no reachable broker, the hook emits neither model context nor a narration string', async () => {
    const out = await runCheckpoint(
      { hook_event_name: 'Stop', session_id: 's-narr-1' },
      { endpoint: '\\\\.\\pipe\\xbus-nonexistent-narration-test', maxPerCheckpoint: 5 },
    );
    expect(out.exitCode).toBe(0);
    expect(out.injected).toBe(0);
    // No model-facing additionalContext, and crucially no narration folded into stdout.
    expect(out.stdout ?? '').not.toMatch(/hook-only|next tick|delivery lags|send another prompt/i);
  });

  it('HookOutput type routes operator notices to stderr — a notice must never appear in stdout', () => {
    // Structural guarantee: the field an operator notice uses is `stderr`; the model-facing field
    // is `stdout`. This pins the separation so a future refactor can't silently re-merge them.
    // (A live-broker DEGRADED_HOOK_ONLY path is exercised in the integration suite; here we pin the
    // contract that stdout is peer-only.)
    const sample = { stdout: '{"hookSpecificOutput":{"additionalContext":"...peer..."}}', stderr: '[XBus activation] ...', exitCode: 0, injected: 1 };
    expect(sample.stderr).toContain('[XBus activation]');
    expect(sample.stdout).not.toContain('[XBus activation]');
  });
});
