import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { encodeFrame, FrameDecoder } from '../../src/ipc/framing.js';
import { isXBusError } from '../../src/protocol/errors.js';

describe('framing: encode/decode round-trip', () => {
  it('round-trips a single frame', () => {
    const d = new FrameDecoder();
    const r = d.push(encodeFrame({ hello: 'world', n: 42 }));
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]).toEqual({ hello: 'world', n: 42 });
  });

  it('handles a partial read (header split from body, body split)', () => {
    const frame = encodeFrame({ a: 'partial-read-test' });
    const d = new FrameDecoder();
    // feed 2 bytes (partial header), then the rest in pieces
    expect(d.push(frame.subarray(0, 2)).frames).toHaveLength(0);
    expect(d.push(frame.subarray(2, 4)).frames).toHaveLength(0); // header complete, no body
    expect(d.push(frame.subarray(4, 7)).frames).toHaveLength(0); // partial body
    const r = d.push(frame.subarray(7));
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]).toEqual({ a: 'partial-read-test' });
  });

  it('handles multiple frames coalesced in one read', () => {
    const buf = Buffer.concat([encodeFrame({ i: 1 }), encodeFrame({ i: 2 }), encodeFrame({ i: 3 })]);
    const d = new FrameDecoder();
    const r = d.push(buf);
    expect(r.frames).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
  });

  it('enforces a fairness drain cap and resumes via continueDrain', () => {
    const frames = Array.from({ length: 5 }, (_, i) => encodeFrame({ i }));
    const d = new FrameDecoder({ drainCap: 2 });
    const r1 = d.push(Buffer.concat(frames));
    expect(r1.frames).toHaveLength(2);
    expect(r1.hasMore).toBe(true);
    const r2 = d.continueDrain();
    expect(r2.frames).toHaveLength(2);
    const r3 = d.continueDrain();
    expect(r3.frames).toHaveLength(1);
    expect(r3.hasMore).toBe(false);
  });

  it('rejects a declared length over the cap BEFORE buffering the body', () => {
    const d = new FrameDecoder({ maxFrameBytes: 64 });
    const evil = Buffer.alloc(4);
    evil.writeUInt32BE(1_000_000, 0); // declare 1MB, send only header
    try {
      d.push(evil);
      throw new Error('expected FRAME_TOO_LARGE');
    } catch (e) {
      expect(isXBusError(e)).toBe(true);
    }
  });

  it('rejects zero-length and invalid JSON frames', () => {
    const d1 = new FrameDecoder();
    const zero = Buffer.alloc(4);
    zero.writeUInt32BE(0, 0);
    expect(() => d1.push(zero)).toThrow();

    const d2 = new FrameDecoder();
    const badBody = Buffer.from('not json');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(badBody.length, 0);
    expect(() => d2.push(Buffer.concat([hdr, badBody]))).toThrow();
  });

  it('property: any JSON-serializable record round-trips, any chunking', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean())),
        fc.integer({ min: 1, max: 7 }),
        (obj, chunkSize) => {
          const frame = encodeFrame(obj);
          const d = new FrameDecoder({ drainCap: 0 });
          const collected: unknown[] = [];
          for (let i = 0; i < frame.length; i += chunkSize) {
            const r = d.push(frame.subarray(i, Math.min(i + chunkSize, frame.length)));
            collected.push(...r.frames);
          }
          expect(collected).toHaveLength(1);
          expect(collected[0]).toEqual(obj);
        },
      ),
      { numRuns: 200 },
    );
  });
});
