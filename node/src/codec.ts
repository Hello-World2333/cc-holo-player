/**
 * Encoder + reference decoder for ccv v1.
 * The reference decoder MUST be bit-exact with cc/decoder.lua.
 */
import { BlockData, MODE, FRAME_FLAG_KEY } from "./protocol.js";

/** 2-bit-per-channel palette levels; must match the CC side's setColorMapping. */
export const LEVELS = [0, 85, 170, 255];

/** Distance between adjacent levels. */
const STEP = 85;

/**
 * Map a channel value to a 2-bit level index.
 * `offset` shifts the decision thresholds, which is all dithering is.
 *
 * Written as round((v+offset)/85) rather than the old explicit threshold chain
 * (43/128/213) because that form makes the dither offset expressible at all; the
 * two agree exactly at offset 0 (43 -> 0.505 -> 1, 213 -> 2.506 -> 3).
 */
function q(c: number, offset = 0): number {
  const x = (c + offset) / STEP;
  if (x <= 0) return 0;
  if (x >= 3) return 3;
  return Math.round(x);
}

/** Recursive Bayer matrix of size n (n a power of two), values 0..n*n-1. */
function bayer(n: number): number[][] {
  if (n === 1) return [[0]];
  const half = bayer(n / 2);
  const h = n / 2;
  const out: number[][] = [];
  for (let y = 0; y < n; y++) out.push(new Array(n).fill(0));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) {
      const v = half[y][x] * 4;
      out[y][x] = v + 0;
      out[y][x + h] = v + 2;
      out[y + h][x] = v + 3;
      out[y + h][x + h] = v + 1;
    }
  }
  return out;
}

const BAYER4 = bayer(4);
const BAYER8 = bayer(8);

/**
 * - `none`   plain nearest-level rounding (the original behaviour)
 * - `bayer4` / `bayer8`  ordered dither, fixed pattern per screen position
 * - `fs`     Floyd-Steinberg error diffusion, serpentine
 *
 * Ordered dithering is the default for video because the pattern depends only on
 * (x,y): a static scene quantizes to byte-identical blocks frame after frame, so
 * SKIP and MV still fire. Error diffusion propagates each pixel's error into its
 * neighbours, so the tiniest source noise reshuffles the whole downstream
 * pattern — which this codec cannot afford (see docs/02 §5.1).
 */
export type DitherMode = "none" | "bayer4" | "bayer8" | "fs";

export function isDitherMode(s: string): s is DitherMode {
  return s === "none" || s === "bayer4" || s === "bayer8" || s === "fs";
}

export interface QuantOpts {
  dither?: DitherMode;
  /** 0 disables the effect, 1 is full strength. */
  strength?: number;
}

/**
 * RGB24 -> 1 byte per pixel (R2 G2 B2 A2=3), row-major.
 *
 * Alpha is always 3: the hologram treats A=0 as invisible, so an unset alpha
 * would make every dithered pixel vanish rather than darken.
 */
export function quantize(
  rgb: Uint8Array,
  w: number,
  h: number,
  o: QuantOpts = {},
): Uint8Array {
  const mode = o.dither ?? "none";
  const strength = o.strength ?? 1;
  if (mode === "fs") return quantizeFS(rgb, w, h, strength);

  const mat = mode === "bayer8" ? BAYER8 : mode === "bayer4" ? BAYER4 : null;
  // Normalise by the CELL COUNT, not the side length: a Bayer matrix of side n
  // holds n*n entries, and dividing by n instead made the offset span ±637
  // instead of ±42.5, which randomises the image instead of dithering it.
  const cells = mat ? mat.length * mat.length : 0;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 3;
      let off = 0;
      if (mat) {
        // (m + 0.5)/cells - 0.5 spans (-0.5, 0.5), scaled to one level: ±42.5.
        const n = mat.length;
        off = ((mat[y % n][x % n] + 0.5) / cells - 0.5) * STEP * strength;
      }
      out[y * w + x] =
        (q(rgb[p], off) << 6) |
        (q(rgb[p + 1], off) << 4) |
        (q(rgb[p + 2], off) << 2) |
        3;
    }
  }
  return out;
}

/** Floyd-Steinberg, serpentine. Error is carried in a two-row float buffer. */
function quantizeFS(rgb: Uint8Array, w: number, h: number, strength: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const rowLen = (w + 2) * 3;
  let curErr = new Float32Array(rowLen);
  let nextErr = new Float32Array(rowLen);
  for (let y = 0; y < h; y++) {
    nextErr.fill(0);
    const ltr = (y & 1) === 0;
    for (let k = 0; k < w; k++) {
      const x = ltr ? k : w - 1 - k;
      const p = (y * w + x) * 3;
      const ci = (x + 1) * 3;   // +1 column of padding so ci-3 / ci+3 stay in range
      let packed = 0;
      for (let c = 0; c < 3; c++) {
        const want = rgb[p + c] + curErr[ci + c];
        const lv = q(want);
        const err = (want - lv * STEP) * strength;
        packed |= lv << (6 - c * 2);
        // right 7/16, down-left 3/16, down 5/16, down-right 1/16 (mirrored for rtl)
        const fwd = ltr ? 3 : -3;
        curErr[ci + fwd + c] += (err * 7) / 16;
        nextErr[ci - fwd + c] += (err * 3) / 16;
        nextErr[ci + c] += (err * 5) / 16;
        nextErr[ci + fwd + c] += err / 16;
      }
      out[y * w + x] = packed | 3;
    }
    const t = curErr; curErr = nextErr; nextErr = t;
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
/** Block origin in pixels. */
function blockOrigin(g: Rect, bi: number): { px: number; py: number } {
  return { px: (bi % g.bx) * g.block, py: Math.floor(bi / g.bx) * g.block };
}

/**
 * True when the MV source rect lies fully inside the region.
 * The hologram's blitFrameBufferArea does NOT clamp a negative source index —
 * it indexes straight into the byte array and throws
 * (java.lang.ArrayIndexOutOfBoundsException). So the encoder must never emit
 * an MV that escapes the region. docs/01 §4.1 states this as an obligation.
 */
function mvInBounds(g: Rect, px: number, py: number, dx: number, dy: number): boolean {
  const B = g.block;
  return px + dx >= 0 && px + dx + B <= g.w && py + dy >= 0 && py + dy + B <= g.h;
}

function sadAt(
  cur: Uint8Array, prev: Uint8Array, g: Rect,
  bi: number, dx: number, dy: number, stride: number,
): number {
  const B = g.block;
  const { px, py } = blockOrigin(g, bi);
  // Check the WHOLE rect up front: sampling with stride would otherwise accept a
  // candidate whose last row/column falls outside the region.
  if (!mvInBounds(g, px, py, dx, dy)) return Number.MAX_SAFE_INTEGER;
  let sad = 0;
  for (let y = 0; y < B; y += stride) {
    const ry = py + y + dy;
    const ci = (py + y) * g.w + px;
    const ri = ry * g.w + px + dx;
    for (let x = 0; x < B; x += stride) {
      sad += Math.abs(cur[ci + x] - prev[ri + x]);
    }
  }
  return sad;
}

/** Full-resolution SAD, clipped to bounds; returns MAX if the source rect escapes. */
function sadFull(cur: Uint8Array, prev: Uint8Array, g: Rect, bi: number, dx: number, dy: number): number {
  const B = g.block;
  const { px, py } = blockOrigin(g, bi);
  if (!mvInBounds(g, px, py, dx, dy)) return Number.MAX_SAFE_INTEGER;
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
  // Belt and braces: a coarse candidate that refine could never improve on would
  // otherwise survive here with an out-of-region source rect.
  const { px, py } = blockOrigin(g, bi);
  if (!mvInBounds(g, px, py, rx, ry)) return null;
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
      // The CC calls hologram.blitFrameBufferArea, which throws on an
      // out-of-region source index instead of clamping. Reject the vector here
      // rather than emit a frame that kills the player.
      const { px, py } = blockOrigin(g, bi);
      if (!mvInBounds(g, px, py, mv.dx, mv.dy)) {
        throw new Error(
          `codec bug: MV (${mv.dx},${mv.dy}) for block ${bi} at (${px},${py}) escapes ${g.w}x${g.h}`,
        );
      }
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
          // Mirror the hologram exactly: it does NOT clamp, it indexes the byte
          // array and throws ArrayIndexOutOfBoundsException. Clipping to 0 here
          // hid encoder bugs from this reference decoder — which is how a
          // mis-ordered payload survived until the player crashed in-game.
          if (sx < 0 || sx >= cfg.w || sy < 0 || sy >= cfg.h) {
            throw new Error(
              `reference decoder: MV escapes region at block ${blk.index} (${blk.dx},${blk.dy})`,
            );
          }
          dst[dstOff + x] = prev[srcOff + x];
        }
      }
    }
  }
}
