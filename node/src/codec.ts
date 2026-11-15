/**
 * Encoder + reference decoder for ccv v1.
 * The reference decoder MUST be bit-exact with cc/decoder.lua.
 */
import { BlockData, MODE, FRAME_FLAG_KEY } from "./protocol.js";

/** 2-bit-per-channel palette levels; must match the CC side's setColorMapping. */
export const LEVELS = [0, 85, 170, 255];

/** Map an 8-bit channel value to a 2-bit level index. */
function q(c: number): number {
  // 0..42 -> 0, 43..127 -> 1, 128..212 -> 2, else 3
  if (c < 43) return 0;
  if (c < 128) return 1;
  if (c < 213) return 2;
  return 3;
}

/** RGB24 -> 1 byte per pixel (R2 G2 B2 A2=3), row-major. */
export function quantize(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0, n = w * h; i < n; i++, p += 3) {
    out[i] = (q(rgb[p]) << 6) | (q(rgb[p + 1]) << 4) | (q(rgb[p + 2]) << 2) | 3;
  }
  return out;
}

export interface EncCfg { w: number; h: number; block: number }

interface Rect { bx: number; by: number; block: number; w: number; h: number }

function makeGrid(cfg: EncCfg): Rect {
  if (cfg.w % cfg.block !== 0 || cfg.h % cfg.block !== 0) {
    throw new Error(`block ${cfg.block} must divide ${cfg.w}x${cfg.h}`);
  }
  return {
    bx: Math.ceil(cfg.w / cfg.block),
    by: Math.ceil(cfg.h / cfg.block),
    block: cfg.block,
    w: cfg.w,
    h: cfg.h,
  };
}

/** SAD of block (bi) at offset (dx,dy) against prev, sampling every `stride` px. */
function sadAt(
  cur: Uint8Array, prev: Uint8Array, g: Rect,
  bi: number, dx: number, dy: number, stride: number,
): number {
  const B = g.block;
  const px = (bi % g.bx) * B;
  const py = Math.floor(bi / g.bx) * B;
  let sad = 0;
  for (let y = 0; y < B; y += stride) {
    const cy = py + y;
    const ry = cy + dy;
    if (ry < 0 || ry >= g.h) return Number.MAX_SAFE_INTEGER;
    let ci = cy * g.w + px;
    let ri = ry * g.w + px + dx;
    for (let x = 0; x < B; x += stride) {
      const cx = px + x;
      const rx = cx + dx;
      if (rx < 0 || rx >= g.w) return Number.MAX_SAFE_INTEGER;
      sad += Math.abs(cur[ci + x] - prev[ri + x]);
    }
  }
  return sad;
}

/** Full-resolution SAD, clipped to bounds; returns MAX if the source rect escapes. */
function sadFull(cur: Uint8Array, prev: Uint8Array, g: Rect, bi: number, dx: number, dy: number): number {
  const B = g.block;
  const px = (bi % g.bx) * B;
  const py = Math.floor(bi / g.bx) * B;
  if (px + dx < 0 || px + dx + B > g.w || py + dy < 0 || py + dy + B > g.h) return Number.MAX_SAFE_INTEGER;
  let sad = 0;
  for (let y = 0; y < B; y++) {
    let ci = (py + y) * g.w + px;
    let ri = (py + y + dy) * g.w + px + dx;
    for (let x = 0; x < B; x++) sad += Math.abs(cur[ci + x] - prev[ri + x]);
  }
  return sad;
}

const SEARCH_RADIUS = 8;

/**
 * Coarse-then-refine motion search.
 * Returns the best (dx,dy,sad) or null when the best is no better than zero motion.
 */
function searchMV(cur: Uint8Array, prev: Uint8Array, g: Rect, bi: number, sad0: number) {
  let bestDx = 0, bestDy = 0;
  let bestSad = sad0;
  // coarse: step 4 over the window, stride-4 sampling
  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy += 4) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 4) {
      if (dx === 0 && dy === 0) continue;
      // scale the subsampled SAD up by stride^2 for comparison
      const s = sadAt(cur, prev, g, bi, dx, dy, 4) * 16;
      if (s < bestSad) { bestSad = s; bestDx = dx; bestDy = dy; }
    }
  }
  if (bestDx === 0 && bestDy === 0) return null;
  // refine +-3 at full resolution around the coarse winner
  let rx = bestDx, ry = bestDy, rsad = sadFull(cur, prev, g, bi, bestDx, bestDy);
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const nx = bestDx + dx, ny = bestDy + dy;
      const s = sadFull(cur, prev, g, bi, nx, ny);
      if (s < rsad) { rsad = s; rx = nx; ry = ny; }
    }
  }
  if (rx === 0 && ry === 0) return null;
  return { dx: rx, dy: ry, sad: rsad };
}

export interface EncOptions {
  /** mean-abs-error (0..3 scale) below which MV is preferred over RAW */
  mvMad: number;
  /** estimated microseconds per MV call (from docs/02) */
  mvUs: number;
  /** estimated microseconds per RAW pixel */
  rawUs: number;
  /** target per-frame decode budget in ms */
  budgetMs: number;
}

export const DEFAULT_OPTS: EncOptions = {
  mvMad: 0.6,
  mvUs: 10,
  rawUs: 0.31,
  budgetMs: 25,
};

export interface EncodedFrame {
  seq: number;
  flags: number;
  blocks: BlockData[];
  rawPixels: number;
  mvBlocks: number;
  skipBlocks: number;
  estimatedMs: number;
}

/**
 * Encode one quantized frame against `prev` (the encoder's model of CC's prev
 * framebuffer). Mutates `prev` to the post-frame state.
 *
 * Frames whose estimated decode cost exceeds the budget are split into several
 * emitted frames: part 0 carries every MV block (they all read the *same* prev
 * state), later parts carry RAW blocks only. Progressive refresh never uses MV.
 */
export function encodeFrame(
  cur: Uint8Array,
  state: Uint8Array,
  cfg: EncCfg,
  seqStart: number,
  opts: EncOptions = DEFAULT_OPTS,
): EncodedFrame[] {
  const g = makeGrid(cfg);
  const B = cfg.block;
  const nBlocks = g.bx * g.by;
  const pxPerBlock = B * B;

  // ---- pass 1: decide every block, estimate the cost
  const decided: (BlockData | null)[] = new Array(nBlocks).fill(null);
  let rawPixels = 0, mvBlocks = 0;

  for (let bi = 0; bi < nBlocks; bi++) {
    const sad0 = sadFull(cur, state, g, bi, 0, 0);
    if (sad0 === 0) continue; // SKIP: display already shows it

    const mv = searchMV(cur, state, g, bi, sad0);
    if (mv && mv.sad / pxPerBlock <= opts.mvMad) {
      decided[bi] = { index: bi, mode: MODE.MV, dx: mv.dx, dy: mv.dy };
      mvBlocks++;
      continue;
    }
    const px = (bi % g.bx) * B;
    const py = Math.floor(bi / g.bx) * B;
    const buf = Buffer.alloc(pxPerBlock);
    for (let y = 0; y < B; y++) {
      const src = (py + y) * g.w + px;
      buf.set(cur.subarray(src, src + B), y * B);
    }
    decided[bi] = { index: bi, mode: MODE.RAW, pixels: buf };
    rawPixels += pxPerBlock;
  }

  const estimatedMs = (rawPixels * opts.rawUs + mvBlocks * opts.mvUs) / 1000;
  const needsSplit = estimatedMs > opts.budgetMs;

  // The CC keeps display and prev in two separate framebuffers: MV reads prev and
  // writes display. Model that with a second buffer so MV never reads its own output.
  const next = new Uint8Array(state.length);

  /** Apply one group of blocks: write into `next` reading MV sources from `state`. */
  const applyGroup = (blocks: BlockData[]) => {
    next.set(state);
    const bx = g.bx;
    for (const blk of blocks) {
      const px = (blk.index % bx) * B;
      const py = Math.floor(blk.index / bx) * B;
      if (blk.mode === MODE.RAW) {
        for (let y = 0; y < B; y++) {
          next.set(blk.pixels!.subarray(y * B, y * B + B), (py + y) * g.w + px);
        }
      } else {
        // read from `state` (frame N-1), write into `next` — never alias
        for (let y = 0; y < B; y++) {
          const dst = (py + y) * g.w + px;
          const src = (py + y + blk.dy!) * g.w + px + blk.dx!;
          for (let x = 0; x < B; x++) next[dst + x] = state[src + x];
        }
      }
    }
    state.set(next);
  };

  const frames: EncodedFrame[] = [];

  if (!needsSplit) {
    const blocks = decided.filter((d): d is BlockData => d !== null);
    applyGroup(blocks);
    frames.push({
      seq: seqStart, flags: 0, blocks, rawPixels, mvBlocks,
      skipBlocks: nBlocks - blocks.length, estimatedMs,
    });
    return frames;
  }

  // ---- progressive refresh: part 0 carries all MVs, later parts RAW only.
  // No MV in later parts, because each part ends with a display->prev copy and a
  // later MV would then read already-updated pixels instead of the frame N-1 state.
  const perPartPx = Math.max(pxPerBlock, Math.floor((opts.budgetMs * 1000) / opts.rawUs));
  const mvList = decided.filter((d): d is BlockData => d !== null && d.mode === MODE.MV);
  const rawList = decided.filter((d): d is BlockData => d !== null && d.mode === MODE.RAW);

  const parts: BlockData[][] = [];
  let curPart: BlockData[] = [...mvList];
  let curPartPx = 0;
  for (const blk of rawList) {
    if (curPartPx > 0 && curPartPx + pxPerBlock > perPartPx) {
      parts.push(curPart);
      curPart = [];
      curPartPx = 0;
    }
    curPart.push(blk);
    curPartPx += pxPerBlock;
  }
  if (curPart.length > 0) parts.push(curPart);

  for (let k = 0; k < parts.length; k++) {
    const blocks = parts[k];
    const rawPx = blocks.filter((b) => b.mode === MODE.RAW).length * pxPerBlock;
    const mvN = blocks.filter((b) => b.mode === MODE.MV).length;
    const est = (rawPx * opts.rawUs + mvN * opts.mvUs) / 1000;
    applyGroup(blocks);
    frames.push({
      seq: seqStart + k,
      flags: k === 0 ? FRAME_FLAG_KEY : 0,
      blocks, rawPixels: rawPx, mvBlocks: mvN,
      skipBlocks: nBlocks - blocks.length, estimatedMs: est,
    });
  }
  return frames;
}

/**
 * Reference decoder: apply blocks to `dst` (the display buffer model), MV reads
 * from `prev`. Mirrors cc/decoder.lua exactly.
 */
export function applyFrame(
  dst: Uint8Array,
  prev: Uint8Array,
  cfg: EncCfg,
  blocks: BlockData[],
) {
  const B = cfg.block;
  const bx = Math.ceil(cfg.w / B);
  for (const blk of blocks) {
    const px = (blk.index % bx) * B;
    const py = Math.floor(blk.index / bx) * B;
    if (blk.mode === MODE.RAW) {
      for (let y = 0; y < B; y++) {
        const dstOff = (py + y) * cfg.w + px;
        dst.set(blk.pixels!.subarray(y * B, y * B + B), dstOff);
      }
    } else {
      for (let y = 0; y < B; y++) {
        const dstOff = (py + y) * cfg.w + px;
        const srcOff = (py + y + blk.dy!) * cfg.w + px + blk.dx!;
        for (let x = 0; x < B; x++) {
          const sx = px + x + blk.dx!;
          const sy = py + y + blk.dy!;
          dst[dstOff + x] = sx < 0 || sx >= cfg.w || sy < 0 || sy >= cfg.h ? 0 : prev[srcOff + x];
        }
      }
    }
  }
}
