/**
 * ccv v1 wire format. Single source of truth: ../docs/01-码流格式.md
 * Big-endian. Bump VERSION on ANY incompatible change.
 */

export const VERSION = 2;

export const MSG = {
  HELLO: 0x01,
  READY: 0x02,
  FRAME: 0x10,
  ACK: 0x13,
  CONTROL: 0x14,
  STATS: 0x20,
  PING: 0x30,
  PONG: 0x31,
} as const;

/**
 * Block modes. Both reuse modes carry a 3-byte atlas position, so the decoder
 * never has to guess where a tile lives: the encoder owns the whole atlas policy
 * (content matching, LRU eviction) and just states the answer.
 */
export const MODE = {
  /** copy block from prev at (dx,dy) */
  MV: 1,
  /** 3-byte atlas position + tileSize*tileSize raw bytes; also stored into the atlas */
  RAW: 2,
  /** 3-byte atlas position; copy the tile from the atlas */
  ATLAS: 3,
} as const;

export type Mode = 1 | 2 | 3;

/** type(1) seq(2) flags(1) part(1) parts(1) bx(1) by(1) = 8 */
export const FRAME_HDR = 8;
export const FRAME_FLAG_KEY = 1;

export interface AtlasCfg {
  /** tile edge in pixels; always equal to the block size */
  tile: number;
  /** per-slot geometry, must satisfy slotW*slotH <= 393216 */
  slotW: number;
  slotH: number;
  /** number of offscreen framebuffer slots devoted to the atlas */
  slots: number;
}

export interface HelloMsg {
  version: number;
  block: number;
  fps: number;
  wallW: number;
  wallH: number;
  regionX: number;
  regionY: number;
  regionW: number;
  regionH: number;
  flags: number;
  name: string;
  atlas: AtlasCfg;
}

export interface BlockData {
  /** linear block index, row-major: by * bx + x */
  index: number;
  mode: Mode;
  dx?: number; // MV only, signed
  dy?: number; // MV only, signed
  /** RAW / ATLAS: position in the atlas */
  atlasPos?: number;
  /** RAW only: block*block bytes, row-major */
  pixels?: Buffer;
}

export interface FrameMsg {
  seq: number;
  flags: number;
  part: number;
  parts: number;
  bx: number;
  by: number;
  blocks: BlockData[];
}

export function gridDims(regionW: number, regionH: number, block: number) {
  return { bx: Math.ceil(regionW / block), by: Math.ceil(regionH / block) };
}

export function bitmapBytes(bx: number, by: number): number {
  return Math.ceil((bx * by) / 8);
}

/** Bytes of the atlas position field. 2^24 = 16.7M tiles is far past any slot budget. */
export const ATLAS_POS_BYTES = 3;
/** Largest atlas position representable on the wire. */
export const ATLAS_POS_MAX = 0xffffff;

/** Cost in payload bytes of one block (excluding its 1-byte mode). */
export function blockPayloadCost(blk: BlockData): number {
  switch (blk.mode) {
    case MODE.MV: return 2;
    case MODE.ATLAS: return ATLAS_POS_BYTES;
    case MODE.RAW: return ATLAS_POS_BYTES + blk.pixels!.length;
  }
}

export function encodeHello(h: HelloMsg): Buffer {
  const name = Buffer.from(h.name, "ascii");
  const b = Buffer.alloc(24 + name.length);
  b.writeUInt8(MSG.HELLO, 0);
  b.writeUInt8(h.version, 1);
  b.writeUInt8(h.block, 2);
  b.writeUInt8(h.fps, 3);
  b.writeUInt16BE(h.wallW, 4);
  b.writeUInt16BE(h.wallH, 6);
  b.writeUInt16BE(h.regionX, 8);
  b.writeUInt16BE(h.regionY, 10);
  b.writeUInt16BE(h.regionW, 12);
  b.writeUInt16BE(h.regionH, 14);
  b.writeUInt8(h.flags, 16);
  b.writeUInt8(name.length, 17);
  // atlas geometry lives in HELLO because the decoder must allocate the slots
  // before the first frame can reference them.
  b.writeUInt8(h.atlas.tile, 18);
  b.writeUInt16BE(h.atlas.slotW, 19);
  b.writeUInt16BE(h.atlas.slotH, 21);
  b.writeUInt8(h.atlas.slots, 23);
  name.copy(b, 24);
  return b;
}

export function decodeHello(b: Buffer): HelloMsg {
  const nameLen = b.readUInt8(17);
  return {
    version: b.readUInt8(1),
    block: b.readUInt8(2),
    fps: b.readUInt8(3),
    wallW: b.readUInt16BE(4),
    wallH: b.readUInt16BE(6),
    regionX: b.readUInt16BE(8),
    regionY: b.readUInt16BE(10),
    regionW: b.readUInt16BE(12),
    regionH: b.readUInt16BE(14),
    flags: b.readUInt8(16),
    name: b.subarray(24, 24 + nameLen).toString("ascii"),
    atlas: {
      tile: b.readUInt8(18),
      slotW: b.readUInt16BE(19),
      slotH: b.readUInt16BE(21),
      slots: b.readUInt8(23),
    },
  };
}

export function encodeFramePart(
  seq: number,
  flags: number,
  part: number,
  parts: number,
  bx: number,
  by: number,
  blocks: BlockData[],
): Buffer {
  const nBitmap = bitmapBytes(bx, by);
  const bm = Buffer.alloc(nBitmap);
  // The wire format carries no per-block index: the decoder walks the bitmap in
  // ascending block order and pairs it with the payload records in order. So the
  // records MUST be sorted by index. The progressive-refresh path builds a part as
  // [...MV blocks, ...RAW blocks], which is not ascending — sorting here is what
  // keeps encoder and decoder talking about the same blocks.
  const ordered = [...blocks].sort((a, b) => a.index - b.index);
  let payload = 0;
  for (const blk of ordered) {
    bm[blk.index >> 3] |= 1 << (blk.index & 7);
    payload += 1 + blockPayloadCost(blk);
  }
  const out = Buffer.alloc(FRAME_HDR + nBitmap + payload);
  out.writeUInt8(MSG.FRAME, 0);
  out.writeUInt16BE(seq, 1);
  out.writeUInt8(flags, 3);
  out.writeUInt8(part, 4);
  out.writeUInt8(parts, 5);
  out.writeUInt8(bx, 6);
  out.writeUInt8(by, 7);
  bm.copy(out, FRAME_HDR);
  let p = FRAME_HDR + nBitmap;
  for (const blk of ordered) {
    if (blk.mode === MODE.MV) {
      out.writeUInt8(MODE.MV, p); p += 1;
      // docs/01 §2: signed values are u8 biased by +128, not two's complement.
      out.writeUInt8(blk.dx! + 128, p); p += 1;
      out.writeUInt8(blk.dy! + 128, p); p += 1;
    } else if (blk.mode === MODE.ATLAS) {
      out.writeUInt8(MODE.ATLAS, p); p += 1;
      out.writeUIntBE(blk.atlasPos!, p, ATLAS_POS_BYTES); p += ATLAS_POS_BYTES;
    } else {
      out.writeUInt8(MODE.RAW, p); p += 1;
      out.writeUIntBE(blk.atlasPos!, p, ATLAS_POS_BYTES); p += ATLAS_POS_BYTES;
      blk.pixels!.copy(out, p); p += blk.pixels!.length;
    }
  }
  return out;
}

/** Split one frame's blocks into parts whose encoded size stays under maxBytes. */
export function frameParts(
  seq: number,
  flags: number,
  bx: number,
  by: number,
  blocks: BlockData[],
  maxBytes: number,
): Buffer[] {
  const overhead = FRAME_HDR + bitmapBytes(bx, by);
  const chunks: BlockData[][] = [];
  let cur: BlockData[] = [];
  let size = overhead;
  for (const blk of blocks) {
    const cost = 1 + blockPayloadCost(blk);
    if (cur.length > 0 && size + cost > maxBytes) {
      chunks.push(cur);
      cur = [];
      size = overhead;
    }
    cur.push(blk);
    size += cost;
  }
  if (cur.length > 0 || chunks.length === 0) chunks.push(cur);
  return chunks.map((c, i) => encodeFramePart(seq, flags, i, chunks.length, bx, by, c));
}

export function decodeFrame(b: Buffer, block: number): FrameMsg {
  const seq = b.readUInt16BE(1);
  const flags = b.readUInt8(3);
  const part = b.readUInt8(4);
  const parts = b.readUInt8(5);
  const bx = b.readUInt8(6);
  const by = b.readUInt8(7);
  const nBitmap = bitmapBytes(bx, by);
  const bmOff = FRAME_HDR;
  let p = bmOff + nBitmap;
  const blocks: BlockData[] = [];
  for (let i = 0; i < bx * by; i++) {
    if (!(b[bmOff + (i >> 3)] & (1 << (i & 7)))) continue;
    const mode = b.readUInt8(p); p += 1;
    if (mode === MODE.MV) {
      blocks.push({ index: i, mode: MODE.MV, dx: b.readUInt8(p) - 128, dy: b.readUInt8(p + 1) - 128 });
      p += 2;
    } else if (mode === MODE.ATLAS) {
      blocks.push({ index: i, mode: MODE.ATLAS, atlasPos: b.readUIntBE(p, ATLAS_POS_BYTES) });
      p += ATLAS_POS_BYTES;
    } else if (mode === MODE.RAW) {
      const atlasPos = b.readUIntBE(p, ATLAS_POS_BYTES);
      p += ATLAS_POS_BYTES;
      blocks.push({
        index: i, mode: MODE.RAW, atlasPos,
        pixels: Buffer.from(b.subarray(p, p + block * block)),
      });
      p += block * block;
    } else {
      throw new Error(`unknown mode ${mode} at block ${i}`);
    }
  }
  return { seq, flags, part, parts, bx, by, blocks };
}

export interface AckMsg { seq: number; status: number; decodeMs: number }

export function decodeAck(b: Buffer): AckMsg {
  return { seq: b.readUInt16BE(1), status: b.readUInt8(3), decodeMs: b.length >= 6 ? b.readUInt16BE(4) : 0 };
}

export function encodeAck(seq: number, status = 0, decodeMs = 0): Buffer {
  const b = Buffer.alloc(6);
  b.writeUInt8(MSG.ACK, 0);
  b.writeUInt16BE(seq, 1);
  b.writeUInt8(status, 3);
  b.writeUInt16BE(decodeMs, 4);
  return b;
}

export const CTRL = { PLAY: 0, PAUSE: 1, SEEK: 2, SET_FPS: 3, STOP: 4 } as const;

export function encodeControl(cmd: number, arg = 0): Buffer {
  const b = Buffer.alloc(6);
  b.writeUInt8(MSG.CONTROL, 0);
  b.writeUInt8(cmd, 1);
  b.writeUInt32BE(arg >>> 0, 2);
  return b;
}

export function encodePing(): Buffer { return Buffer.from([MSG.PING]); }
