/**
 * IPC wire framing: 4-byte big-endian length prefix + UTF-8 JSON payload.
 * Length excludes the 4-byte prefix.
 *
 * The decoder is a pure, incremental state machine: feed it arbitrary byte
 * chunks (partial reads, multiple frames coalesced in one read) and it yields
 * complete frame payloads. It enforces the per-frame size cap BEFORE
 * allocating/accumulating a body, and supports a fairness cap on how many
 * frames are drained per call (F18 — prevents event-loop monopolization).
 */
import { XBusError, XBusErrorCode } from '../protocol/errors.js';
import { LIMITS } from '../protocol/schemas.js';

const PREFIX_BYTES = 4;

export interface DecodeResult {
  /** Decoded JSON payloads, in order. */
  frames: unknown[];
  /** True if more complete frames remain buffered (fairness cap hit). */
  hasMore: boolean;
}

export interface FrameDecoderOptions {
  maxFrameBytes?: number;
  /** Max frames to emit per drain() call (fairness). 0 = unlimited. */
  drainCap?: number;
}

/** Encode a single value into a length-prefixed frame buffer. */
export function encodeFrame(value: unknown, maxFrameBytes: number = LIMITS.FRAME_BYTES): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  if (json.length > maxFrameBytes) {
    throw new XBusError(XBusErrorCode.FRAME_TOO_LARGE, 'outbound frame exceeds limit', {
      limit: maxFrameBytes,
      actual: json.length,
    });
  }
  const out = Buffer.allocUnsafe(PREFIX_BYTES + json.length);
  out.writeUInt32BE(json.length, 0);
  json.copy(out, PREFIX_BYTES);
  return out;
}

/**
 * Incremental frame decoder. One per connection. Holds a bounded internal
 * buffer; the caller is responsible for global buffer-budget accounting and
 * idle timeouts (see broker/IPC server).
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;
  private readonly drainCap: number;

  constructor(opts: FrameDecoderOptions = {}) {
    this.maxFrameBytes = opts.maxFrameBytes ?? LIMITS.FRAME_BYTES;
    this.drainCap = opts.drainCap ?? 32;
  }

  /** Bytes currently buffered (for global budget accounting). */
  get bufferedBytes(): number {
    return this.buf.length;
  }

  /**
   * Push a chunk and drain complete frames. Throws XBusError on a declared
   * length exceeding the cap (caller should close the connection — stream sync
   * is unrecoverable after an oversized declaration).
   */
  push(chunk: Buffer): DecodeResult {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    return this.drain();
  }

  private drain(): DecodeResult {
    const frames: unknown[] = [];
    let count = 0;
    for (;;) {
      if (this.buf.length < PREFIX_BYTES) break;
      const len = this.buf.readUInt32BE(0);
      if (len === 0) {
        throw new XBusError(XBusErrorCode.PROTOCOL_VIOLATION, 'zero-length frame');
      }
      if (len > this.maxFrameBytes) {
        // Reject BEFORE accumulating the body.
        throw new XBusError(XBusErrorCode.FRAME_TOO_LARGE, 'declared frame length exceeds limit', {
          limit: this.maxFrameBytes,
          declared: len,
        });
      }
      if (this.buf.length < PREFIX_BYTES + len) break; // incomplete; wait for more
      const body = this.buf.subarray(PREFIX_BYTES, PREFIX_BYTES + len);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        throw new XBusError(XBusErrorCode.PROTOCOL_VIOLATION, 'invalid JSON frame');
      }
      frames.push(parsed);
      this.buf = this.buf.subarray(PREFIX_BYTES + len);
      count += 1;
      if (this.drainCap > 0 && count >= this.drainCap) {
        return { frames, hasMore: this.hasCompleteFrame() };
      }
    }
    return { frames, hasMore: false };
  }

  /** Continue draining after a fairness yield. */
  continueDrain(): DecodeResult {
    return this.drain();
  }

  private hasCompleteFrame(): boolean {
    if (this.buf.length < PREFIX_BYTES) return false;
    const len = this.buf.readUInt32BE(0);
    return this.buf.length >= PREFIX_BYTES + len;
  }
}
