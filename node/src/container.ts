/**
 * .ccv container: a header, a flat index of pre-encoded ws messages, then blobs.
 * Every index record is exactly one websocket message, so the server never has
 * to re-frame anything.
 */
import * as fs from "node:fs";

/**
 * Magic carries the format generation, not the app name: a v1 file's header
 * layout differs (no atlas fields), so accepting it on the magic alone would
 * misparse every field after the duration.
 */
export const CCV_MAGIC = "CCV2";
export const CCV_VERSION = 2;
export const HDR_SIZE = 48;
export const REC_SIZE = 16;

export interface CcvHeader {
  version: number;
  block: number;
  fps: number;
  wallW: number;
  wallH: number;
  regionX: number;
  regionY: number;
  regionW: number;
  regionH: number;
  msgCount: number;
  indexOffset: number;
  durationMs: number;
  /**
   * Atlas geometry. The decoder must allocate these slots before the first
   * frame, and it cannot infer them: `tiles` are addressed by a flat position
   * whose mapping to (slot, x, y) depends entirely on this geometry.
   * Zero slots means the file is not atlas-coded.
   */
  atlasSlots: number;
  atlasSlotW: number;
  atlasSlotH: number;
}

export interface CcvRecord {
  offset: number;
  length: number;
  seq: number;
  part: number;
  parts: number;
  timeMs: number;
}

export class CcvWriter {
  private fd: number;
  private idx: Buffer[] = [];
  private dataOffset = HDR_SIZE;
  private written = 0;

  constructor(path: string, private header: Omit<CcvHeader, "msgCount" | "indexOffset" | "durationMs">) {
    this.fd = fs.openSync(path, "w");
    // placeholder header; rewritten by close()
    fs.writeSync(this.fd, Buffer.alloc(HDR_SIZE), 0, HDR_SIZE, 0);
  }

  add(msg: Buffer, seq: number, part: number, parts: number, timeMs: number) {
    const off = this.dataOffset + this.written;
    fs.writeSync(this.fd, msg, 0, msg.length, off);
    this.written += msg.length;
    const r = Buffer.alloc(REC_SIZE);
    r.writeUInt32BE(off, 0);
    r.writeUInt32BE(msg.length, 4);
    r.writeUInt16BE(seq, 8);
    r.writeUInt8(part, 10);
    r.writeUInt8(parts, 11);
    r.writeUInt32BE(timeMs, 12);
    this.idx.push(r);
  }

  close(durationMs: number): CcvHeader {
    const indexOffset = this.dataOffset + this.written;
    let p = indexOffset;
    for (const r of this.idx) { fs.writeSync(this.fd, r, 0, REC_SIZE, p); p += REC_SIZE; }
    const hdr = Buffer.alloc(HDR_SIZE);
    hdr.write(CCV_MAGIC, 0, "ascii");
    hdr.writeUInt8(this.header.version, 4);
    hdr.writeUInt8(this.header.block, 5);
    hdr.writeUInt8(this.header.fps, 6);
    hdr.writeUInt8(0, 7);
    hdr.writeUInt16BE(this.header.wallW, 8);
    hdr.writeUInt16BE(this.header.wallH, 10);
    hdr.writeUInt16BE(this.header.regionX, 12);
    hdr.writeUInt16BE(this.header.regionY, 14);
    hdr.writeUInt16BE(this.header.regionW, 16);
    hdr.writeUInt16BE(this.header.regionH, 18);
    hdr.writeUInt32BE(this.idx.length, 20);
    hdr.writeUInt32BE(indexOffset, 24);
    hdr.writeUInt32BE(durationMs, 28);
    hdr.writeUInt8(this.header.atlasSlots, 32);
    hdr.writeUInt16BE(this.header.atlasSlotW, 33);
    hdr.writeUInt16BE(this.header.atlasSlotH, 35);
    fs.writeSync(this.fd, hdr, 0, HDR_SIZE, 0);
    fs.closeSync(this.fd);
    return {
      ...this.header,
      msgCount: this.idx.length,
      indexOffset,
      durationMs,
    };
  }
}

export function readCcvHeader(fd: number): CcvHeader {
  const b = Buffer.alloc(HDR_SIZE);
  fs.readSync(fd, b, 0, HDR_SIZE, 0);
  const magic = b.toString("ascii", 0, 4);
  if (magic !== CCV_MAGIC) {
    throw new Error(
      magic === "CCV1"
        ? "this is a ccv v1 file; re-transcode it (the atlas fields changed the header)"
        : `not a .ccv file (magic ${JSON.stringify(magic)})`,
    );
  }
  return {
    version: b.readUInt8(4),
    block: b.readUInt8(5),
    fps: b.readUInt8(6),
    wallW: b.readUInt16BE(8),
    wallH: b.readUInt16BE(10),
    regionX: b.readUInt16BE(12),
    regionY: b.readUInt16BE(14),
    regionW: b.readUInt16BE(16),
    regionH: b.readUInt16BE(18),
    msgCount: b.readUInt32BE(20),
    indexOffset: b.readUInt32BE(24),
    durationMs: b.readUInt32BE(28),
    atlasSlots: b.readUInt8(32),
    atlasSlotW: b.readUInt16BE(33),
    atlasSlotH: b.readUInt16BE(35),
  };
}

export function readCcvRecords(fd: number, h: CcvHeader): CcvRecord[] {
  const buf = Buffer.alloc(h.msgCount * REC_SIZE);
  fs.readSync(fd, buf, 0, buf.length, h.indexOffset);
  const out: CcvRecord[] = [];
  for (let i = 0; i < h.msgCount; i++) {
    const o = i * REC_SIZE;
    out.push({
      offset: buf.readUInt32BE(o),
      length: buf.readUInt32BE(o + 4),
      seq: buf.readUInt16BE(o + 8),
      part: buf.readUInt8(o + 10),
      parts: buf.readUInt8(o + 11),
      timeMs: buf.readUInt32BE(o + 12),
    });
  }
  return out;
}

export function readCcvMessage(fd: number, r: CcvRecord): Buffer {
  const b = Buffer.alloc(r.length);
  fs.readSync(fd, b, 0, r.length, r.offset);
  return b;
}
