/**
 * Canonical length-prefixed binary encoding for the XBus Secure Transport
 * handshake (spec §1). Deterministic — the transcript hash is computed over these
 * exact bytes, NEVER over JSON. A tiny writer/reader avoids ambiguity.
 */

export class ByteWriter {
  private chunks: Buffer[] = [];
  u8(n: number): this { const b = Buffer.allocUnsafe(1); b.writeUInt8(n & 0xff, 0); this.chunks.push(b); return this; }
  u16(n: number): this { const b = Buffer.allocUnsafe(2); b.writeUInt16BE(n & 0xffff, 0); this.chunks.push(b); return this; }
  u32(n: number): this { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n >>> 0, 0); this.chunks.push(b); return this; }
  /** length-prefixed (u16) raw bytes */
  bytes(buf: Buffer): this { this.u16(buf.length); this.chunks.push(Buffer.from(buf)); return this; }
  /** length-prefixed UTF-8 string */
  str(s: string): this { return this.bytes(Buffer.from(s, 'utf8')); }
  /** u16 count then each u16 */
  u16Array(arr: number[]): this { this.u16(arr.length); for (const n of arr) this.u16(n); return this; }
  /** raw (no length prefix) — for fixed-width fields like nonces/tags */
  raw(buf: Buffer): this { this.chunks.push(Buffer.from(buf)); return this; }
  done(): Buffer { return Buffer.concat(this.chunks); }
}

export class ByteReader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}
  private need(n: number): void { if (this.off + n > this.buf.length) throw new Error('STP_DECODE_UNDERRUN'); }
  u8(): number { this.need(1); const v = this.buf.readUInt8(this.off); this.off += 1; return v; }
  u16(): number { this.need(2); const v = this.buf.readUInt16BE(this.off); this.off += 2; return v; }
  u32(): number { this.need(4); const v = this.buf.readUInt32BE(this.off); this.off += 4; return v; }
  bytes(): Buffer { const len = this.u16(); this.need(len); const v = this.buf.subarray(this.off, this.off + len); this.off += len; return Buffer.from(v); }
  str(): string { return this.bytes().toString('utf8'); }
  u16Array(): number[] { const n = this.u16(); const out: number[] = []; for (let i = 0; i < n; i++) out.push(this.u16()); return out; }
  raw(n: number): Buffer { this.need(n); const v = this.buf.subarray(this.off, this.off + n); this.off += n; return Buffer.from(v); }
  get remaining(): number { return this.buf.length - this.off; }
}
