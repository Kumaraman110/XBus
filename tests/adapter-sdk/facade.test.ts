/**
 * BrokerFacade tests (§16.22 + the seam contract). Proves the facade maps 1:1 onto
 * the EXISTING FrameType verbs (no new wire verb), surfaces broker `error` frames as
 * typed AdapterErrors, and exposes no broker internals. Uses a fake IpcClient that
 * records the (frameType, payload) it was asked to send — so we assert the wire
 * contract without a real broker.
 */
import { describe, it, expect } from 'vitest';
import { makeBrokerFacade, AdapterError, AdapterErrorCode } from '../../src/adapter/index.js';
import type { Frame, FrameType } from '../../src/protocol/commands.js';
import type { IpcClient } from '../../src/ipc/client.js';

interface Sent { frameType: FrameType; payload: unknown }

/** A minimal fake IpcClient capturing requests and returning a scripted frame. */
function fakeClient(reply: (frameType: FrameType, payload: unknown) => Frame): { client: IpcClient; sent: Sent[]; pushHandlers: Array<(f: Frame) => void> } {
  const sent: Sent[] = [];
  const pushHandlers: Array<(f: Frame) => void> = [];
  const client = {
    request(frameType: FrameType, payload: unknown): Promise<Frame> {
      sent.push({ frameType, payload });
      return Promise.resolve(reply(frameType, payload));
    },
    onPush(cb: (f: Frame) => void): void { pushHandlers.push(cb); },
    onClose(): void {},
    close(): void {},
  } as unknown as IpcClient;
  return { client, sent, pushHandlers };
}

const ok = (frameType: FrameType, payload: unknown): Frame => ({ protocolVersion: 1, frameType: `${frameType}_ack` as FrameType, timestamp: 't', payload: { echoed: payload } });

describe('BrokerFacade — 1:1 mapping to existing FrameTypes (§16.22, §14)', () => {
  it('each facade method issues exactly the existing verb frame', async () => {
    const { client, sent } = fakeClient(ok);
    const f = makeBrokerFacade(client);
    await f.registerSession({ sessionId: 's1', receiveMode: 'hook_checkpoint' });
    await f.registerAlias('reviewer');
    await f.send({ to: 'a', text: 'hi' });
    await f.pullCheckpoint({ checkpointId: 'c1', limit: 5 });
    await f.inbox({ limit: 10 });
    await f.redeliver({ messageId: 'm1' });
    await f.acknowledge({ injectionId: 'i1', status: 'accepted' });
    await f.reply({ injectionId: 'i1', text: 'done' });
    await f.listSessions();
    await f.signalReadiness({ ackAvailable: true, versionOk: true });
    await f.getStatus();

    const verbs = sent.map((s) => s.frameType);
    // every verb is an EXISTING FrameType from src/protocol/commands.ts — no new wire verb
    expect(verbs).toEqual([
      'register_session', 'register_alias', 'send_message', 'checkpoint_pull_hook',
      'inbox', 'redeliver', 'ack_message', 'reply_message', 'list_sessions',
      'signal_readiness', 'get_status',
    ]);
  });

  it('pullCheckpoint sends checkpoint_pull_hook (no caller-supplied sessionId in the verb)', async () => {
    const { client, sent } = fakeClient(ok);
    const f = makeBrokerFacade(client);
    await f.pullCheckpoint({ checkpointId: 'c1', limit: 3 });
    expect(sent[0]!.frameType).toBe('checkpoint_pull_hook');
    // the payload carries only checkpointId + limit — identity is the broker's job
    expect(sent[0]!.payload).toEqual({ checkpointId: 'c1', limit: 3 });
  });

  it('a broker error frame becomes a typed AdapterError (not a raw throw)', async () => {
    const { client } = fakeClient((ft) => ft === 'send_message'
      ? ({ protocolVersion: 1, frameType: 'error', timestamp: 't', payload: { code: 'XBUS_UNKNOWN_RECIPIENT', message: 'no such alias' } })
      : ok(ft, {}));
    const f = makeBrokerFacade(client);
    await expect(f.send({ to: 'ghost', text: 'x' })).rejects.toBeInstanceOf(AdapterError);
    try { await f.send({ to: 'ghost', text: 'x' }); } catch (e) {
      const ae = e as AdapterError;
      expect(ae.code).toBe(AdapterErrorCode.DELIVERY_FAILED);
      // the broker's code is carried in safe details; no body/secret leaks
      expect(ae.details.brokerCode).toBe('XBUS_UNKNOWN_RECIPIENT');
    }
  });

  it('onShutdownNotice only fires on the shutdown_notice push frame', async () => {
    const { client, pushHandlers } = fakeClient(ok);
    const f = makeBrokerFacade(client);
    let fired = 0;
    f.onShutdownNotice(() => { fired++; });
    // simulate pushes
    pushHandlers.forEach((h) => h({ protocolVersion: 1, frameType: 'inbox_ack', timestamp: 't', payload: {} }));
    expect(fired).toBe(0);
    pushHandlers.forEach((h) => h({ protocolVersion: 1, frameType: 'shutdown_notice', timestamp: 't', payload: {} }));
    expect(fired).toBe(1);
  });
});
