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
  /** server -> client: one 128x72 packed cover for the item with this key */
  THUMB: 0x15,
  /** client -> server: "resend the catalog" (no payload) */
  CATALOG_REQ: 0x16,
  /** client -> server: key[8]; send just that cover (page-at-a-time on demand) */
  THUMB_REQ: 0x1a,
  /** client -> server: 8 bytes ASCII key; switch playback to that item */
  SELECT: 0x17,
  /** server -> client: the whole media library, see encodeCatalog */
  CATALOG: 0x18,
  /** server -> client: u8 on/off, shown while the server is preparing a stream */
  LOADING: 0x19,
  STATS: 0x20,
  PING: 0x30,
  PONG: 0x31,
} as const;

/**
 * Length of an item key on the wire. The media library is shared with the old
 * player, whose keys are the first 8 hex digits of sha1(file name), so this is
 * fixed rather than length-prefixed.
 */
export const KEY_BYTES = 8;
/** Titles are capped so one catalog can never outgrow a websocket frame. */
export const TITLE_MAX = 96;

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

/**
 * Largest websocket message the client accepts. A frame part carries at most
 * this many bytes; the sender relies on a key frame splitting into ~6 of them.
 * Both the offline writer and the live encoder must use the same value or the
 * two produce different splits for the same content.
 */
export const MAX_FRAME_BYTES = 48 * 1024;

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

export interface CatalogItem {
  /** 8 ASCII bytes */
  key: string;
  title: string;
  durationMs: number;
}

/**
 * u8 type | u16 count | count x (key[8] | u16 sec | u16 titleLen | title)
 *
 * Binary rather than JSON on purpose: the titles are Chinese, and CC's Lua would
 * have to round-trip them through a JSON parser and then re-escape them as
 * literal "\\uXXXX" before drawing (the hologram's drawText only renders CJK from
 * escapes). Keeping the wire format raw UTF-8 means the client does the escaping
 * exactly once, in the one place that needs it.
 */
export function encodeCatalog(items: CatalogItem[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(3);
  head.writeUInt8(MSG.CATALOG, 0);
  head.writeUInt16BE(items.length, 1);
  parts.push(head);
  for (const it of items) {
    let title = Buffer.from(it.title, "utf8");
    if (title.length > TITLE_MAX) {
      // Cut on a codepoint boundary, else the client's UTF-8 walker sees a
      // truncated sequence and emits garbage.
      title = title.subarray(0, TITLE_MAX);
      while (title.length > 0 && (title[title.length - 1] & 0xc0) === 0x80) {
        title = title.subarray(0, title.length - 1);
      }
    }
    const b = Buffer.alloc(KEY_BYTES + 4 + title.length);
    b.write(it.key, 0, KEY_BYTES, "ascii");
    b.writeUInt16BE(Math.min(65535, Math.round(it.durationMs / 1000)), KEY_BYTES);
    b.writeUInt16BE(title.length, KEY_BYTES + 2);
    title.copy(b, KEY_BYTES + 4);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

export function decodeCatalog(b: Buffer): CatalogItem[] {
  const count = b.readUInt16BE(1);
  const out: CatalogItem[] = [];
  let p = 3;
  for (let i = 0; i < count; i++) {
    const key = b.toString("ascii", p, p + KEY_BYTES);
    const sec = b.readUInt16BE(p + KEY_BYTES);
    const len = b.readUInt16BE(p + KEY_BYTES + 2);
    const title = b.toString("utf8", p + KEY_BYTES + 4, p + KEY_BYTES + 4 + len);
    p += KEY_BYTES + 4 + len;
    out.push({ key, title, durationMs: sec * 1000 });
  }
  return out;
}

/** u8 type | u16 w | u16 h | key[8] | packed pixels */
export function encodeThumb(key: string, w: number, h: number, pixels: Buffer): Buffer {
  const b = Buffer.alloc(5 + KEY_BYTES + pixels.length);
  b.writeUInt8(MSG.THUMB, 0);
  b.writeUInt16BE(w, 1);
  b.writeUInt16BE(h, 3);
  b.write(key, 5, KEY_BYTES, "ascii");
  pixels.copy(b, 5 + KEY_BYTES);
  return b;
}

export function encodeSelect(key: string): Buffer {
  const b = Buffer.alloc(1 + KEY_BYTES);
  b.writeUInt8(MSG.SELECT, 0);
  b.write(key, 1, KEY_BYTES, "ascii");
  return b;
}

export function encodeLoading(on: boolean): Buffer {
  return Buffer.from([MSG.LOADING, on ? 1 : 0]);
}

export function encodeCatalogReq(): Buffer {
  return Buffer.from([MSG.CATALOG_REQ]);
}

export function encodeThumbReq(key: string): Buffer {
  const b = Buffer.alloc(1 + KEY_BYTES);
  b.writeUInt8(MSG.THUMB_REQ, 0);
  b.write(key, 1, KEY_BYTES, "ascii");
  return b;
}
