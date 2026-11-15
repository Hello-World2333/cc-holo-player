/**
 * Encoder + reference decoder for ccv v1.
 * The reference decoder MUST be bit-exact with cc/decoder.lua.
 */
import { BlockData, MODE, FRAME_FLAG_KEY } from "./protocol.js";
import type { TileAtlas } from "./atlas.js";

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

  if (!mat) {
    // No dither: one lookup table for every pixel.
    const L = new Uint8Array(256);
    for (let c = 0; c < 256; c++) L[c] = q(c, 0);
    for (let i = 0, p = 0; i < w * h; i++, p += 3) {
      out[i] = (L[rgb[p]] << 6) | (L[rgb[p + 1]] << 4) | (L[rgb[p + 2]] << 2) | 3;
    }
    return out;
  }

  // One 256-entry table per Bayer cell. The offset depends only on (x mod n,
  // y mod n), so every threshold decision is a table lookup instead of three
  // divisions and three Math.round calls per pixel — quantize was 54ns/pixel,
  // which is absurd for what is arithmetically a divide-by-85.
  const n = mat.length;
  const luts: Uint8Array[] = new Array(cells);
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      // (m + 0.5)/cells - 0.5 spans (-0.5, 0.5), scaled to one level: ±42.5.
      const off = ((mat[cy][cx] + 0.5) / cells - 0.5) * STEP * strength;
      const L = new Uint8Array(256);
      for (let c = 0; c < 256; c++) L[c] = q(c, off);
      luts[cy * n + cx] = L;
    }
  }
  // Walk the Bayer matrix by row so the per-row table slice is contiguous.
  const rowLuts: Uint8Array[][] = new Array(n);
  for (let cy = 0; cy < n; cy++) {
    rowLuts[cy] = luts.slice(cy * n, cy * n + n);
  }
  for (let y = 0; y < h; y++) {
    const row = rowLuts[y & (n - 1)];
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const L = row[x & (n - 1)];
      const p = (base + x) * 3;
      out[base + x] =
        (L[rgb[p]] << 6) | (L[rgb[p + 1]] << 4) | (L[rgb[p + 2]] << 2) | 3;
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

/**
 * Sum of per-channel level differences over a block at offset (dx,dy).
 *
 * This replaces the old "SAD on packed bytes". The packed byte is
 * `R<<6 | G<<4 | B<<2 | 3`, so a one-level change in R moves it by 64 and the
 * same change in B moves it by 4 — the old metric weighted red 16x harder than
 * blue and could not be interpreted as a visual error at all. Against the old
 * `mvMad = 0.6` that meant a block had to be very nearly bit-identical to be
 * accepted as an MV, so real motion fell through to RAW: 8 MV blocks per frame
 * against 356 RAW on a 576-block grid.
 *
 * Returns `sum` over R,G,B in 0..3 level units, or null when the source rect
 * leaves the region (the hologram throws instead of clamping, see mvInBounds).
 */
function sadChan(
  cur: Uint8Array, prev: Uint8Array, g: Rect,
  bi: number, dx: number, dy: number, stride: number,
): number | null {
  return sadChanStats(cur, prev, g, bi, dx, dy, stride)?.sum ?? null;
}

/**
 * Full statistics for reusing a block: total per-channel error, worst single
 * pixel, and how many pixels differ at all.
 *
 * The mean alone is not a usable acceptance test. Measured on real content, a
 * block could sit at mean 0.10 levels while still containing pixels off by 9
 * levels (all three channels maximally wrong) — 448 of 576 blocks did. A thin
 * edge or a dither-pattern pixel simply averages away inside a 20x20 block, and
 * on screen that reads as exactly the block-shaped ghosting the mean says cannot
 * be there. So the decision needs the worst pixel and the count, not the average.
 */
function sadChanStats(
  cur: Uint8Array, prev: Uint8Array, g: Rect,
  bi: number, dx: number, dy: number, stride: number,
): { sum: number; max: number; diffPx: number; samples: number } | null {
  const B = g.block;
  const { px, py } = blockOrigin(g, bi);
  // Check the WHOLE rect up front: sampling with stride would otherwise accept a
  // candidate whose last row/column falls outside the region.
  if (!mvInBounds(g, px, py, dx, dy)) return null;
  let sum = 0, max = 0, diffPx = 0, samples = 0;
  for (let y = 0; y < B; y += stride) {
    for (let x = 0; x < B; x += stride) {
      const a = cur[(py + y) * g.w + px + x];
      const b = prev[(py + y + dy) * g.w + px + x + dx];
      samples += 3;
      if (a === b) continue;
      diffPx++;
      const d =
        Math.abs(((a >> 6) & 3) - ((b >> 6) & 3)) +
        Math.abs(((a >> 4) & 3) - ((b >> 4) & 3)) +
        Math.abs(((a >> 2) & 3) - ((b >> 2) & 3));
      sum += d;
      if (d > max) max = d;
    }
  }
  return { sum, max, diffPx, samples };
}

/** Number of per-channel samples sadChan accumulates for a given stride. */
function chanSamples(g: Rect, stride: number): number {
  const n = Math.ceil(g.block / stride) * Math.ceil(g.block / stride);
  return n * 3;
}

/**
 * Motion search, coarse-to-fine, scored by mean per-channel level error.
 *
 * The radius matters as much as the metric: at 20 fps an anime pan easily moves
 * more than 8 px between frames, so a radius of 8 simply cannot express the
 * motion and everything falls through to RAW. Encoder CPU is free here (offline),
 * the decode side does not know or care how far we searched.
 *
 * `maxErr` is the mean per-channel error we are willing to accept. Since one
 * quantization step is a whole level, anything up to ~0.5 is below the noise the
 * codec already introduces by quantizing to 4 levels per channel.
 */
function searchMV(
  cur: Uint8Array, prev: Uint8Array, g: Rect, bi: number,
  o: EncOptions,
): { dx: number; dy: number } | null {
  const radius = o.searchRadius;

  // Coarse: stride 2 over the full radius, NO threshold. Thresholding during the
  // coarse stage once discarded the true motion before the refine stage could
  // see it (mv/frame collapsed to 2). The coarse stage only nominates; the
  // decision happens at full resolution below.
  let bx = 0, by = 0;
  let bestCoarse = sadChan(cur, prev, g, bi, 0, 0, 2) ?? Number.MAX_SAFE_INTEGER;
  for (let dy = -radius; dy <= radius; dy += 4) {
    for (let dx = -radius; dx <= radius; dx += 4) {
      const sum = sadChan(cur, prev, g, bi, dx, dy, 2);
      if (sum === null) continue;
      if (sum < bestCoarse) { bestCoarse = sum; bx = dx; by = dy; }
    }
  }
  if (bx === 0 && by === 0) return null;

  // Fine: full resolution around the coarse winner, keeping the candidate only
  // if the WHOLE block actually passes the reuse test.
  let pick: { dx: number; dy: number; sum: number } | null = null;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = bx + dx, ny = by + dy;
      if (nx === 0 && ny === 0) continue;
      const st = sadChanStats(cur, prev, g, bi, nx, ny, 1);
      if (!st) continue;
      if (!canReuse(st, o)) continue;
      if (!pick || st.sum < pick.sum) pick = { dx: nx, dy: ny, sum: st.sum };
    }
  }
  return pick ? { dx: pick.dx, dy: pick.dy } : null;
}

export interface EncOptions {
  /**
   * Mean per-channel error (0..3 level units) we accept when REUSING the
   * previous frame's pixels, whether at zero offset (SKIP) or at the best
   * motion vector (MV). One quantization step is a full level, so values below
   * ~0.3 are far smaller than the error quantizing to 4 levels already causes.
   * Higher = smaller stream, more staleness. See docs/02 §6.5.
   */
  copyTol: number;
  /**
   * Hard cap on the WORST pixel inside a reused block, in per-channel levels
   * (0..9 = 3 channels x 3). The mean is not enough: a block can average 0.1
   * while containing pixels that are completely wrong, and the eye finds those.
   */
  copyMaxPx: number;
  /** Max share of pixels allowed to differ at all inside a reused block (0..1). */
  copyMaxDiffPct: number;
  /** Motion search radius in pixels. Encoder-only cost; decode cost unchanged. */
  searchRadius: number;
  /** estimated microseconds per MV call (from docs/02) */
  mvUs: number;
  /** estimated microseconds per RAW pixel */
  rawUs: number;
  /** target per-frame decode budget in ms */
  budgetMs: number;
  /**
   * Atlas matching tolerance. Tiles are matched with the same per-channel level
   * error metric as SKIP/MV, and these are the caps used for a match to count.
   * Measured on real content: 8x8 tiles hit 65-69% at these values.
   */
  atlasMaxPx: number;
  atlasMaxMean: number;
}

/** Can this block (at this offset) be replaced by a copy of prev? */
function canReuse(
  st: { sum: number; max: number; diffPx: number; samples: number },
  o: EncOptions,
): boolean {
  return (
    st.sum / st.samples <= o.copyTol &&
    st.max <= o.copyMaxPx &&
    st.diffPx / (st.samples / 3) <= o.copyMaxDiffPct
  );
}

export const DEFAULT_OPTS: EncOptions = {
  copyTol: 0.25,
  copyMaxPx: 2,
  copyMaxDiffPct: 0.3,
  // 24 was the old default. At block=8 with the atlas enabled, 8 measures within
  // 0.6% of the same bitrate for a third less encoder time (docs/02 §4.2).
  searchRadius: 8,
  mvUs: 10,
  rawUs: 0.31,
  budgetMs: 25,
  atlasMaxPx: 2,
  atlasMaxMean: 0.25,
};

export interface EncodedFrame {
  seq: number;
  flags: number;
  blocks: BlockData[];
  rawPixels: number;
  mvBlocks: number;
  atlasBlocks: number;
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
  /** Supply to enable atlas coding; omit to code every changed block as RAW. */
  atlas?: TileAtlas,
  /** frame counter, used for LRU bookkeeping */
  frame = 0,
): EncodedFrame[] {
  const g = makeGrid(cfg);
  const B = cfg.block;
  const nBlocks = g.bx * g.by;
  const pxPerBlock = B * B;

  // ---- pass 1: decide every block, estimate the cost
  const decided: (BlockData | null)[] = new Array(nBlocks).fill(null);
  let rawPixels = 0, mvBlocks = 0, atlasBlocks = 0;

  for (let bi = 0; bi < nBlocks; bi++) {
    // SKIP is "copy the previous frame's block at zero offset". It used to
    // require the packed bytes to be *exactly* equal, which on real content with
    // dithering almost never holds: measured mean channel error for unsent blocks
    // sat at a constant 0.13 levels — an eighth of one quantization step — yet
    // each of those blocks was still paying a full 400-byte RAW retransmission.
    // Allowing that error under the same tolerance the MV copy uses is what makes
    // the block grid collapse; see docs/02 §6.5.
    const zero = sadChanStats(cur, state, g, bi, 0, 0, 1);
    if (zero && canReuse(zero, opts)) continue;

    // Pack the tile once; the atlas and the RAW fallback both need these bytes.
    const px = (bi % g.bx) * B;
    const py = Math.floor(bi / g.bx) * B;
    let buf: Buffer | null = null;
    const packTile = () => {
      if (buf) return buf;
      buf = Buffer.alloc(pxPerBlock);
      for (let y = 0; y < B; y++) {
        const src = (py + y) * g.w + px;
        buf.set(cur.subarray(src, src + B), y * B);
      }
      return buf;
    };

    const mv = searchMV(cur, state, g, bi, opts);
    if (mv) {
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
    const tile = packTile();
    if (atlas && atlas.tile === B) {
      // Motion search runs first: an MV costs 3 bytes on the wire against 4 for
      // an ATLAS reference, and it is the only way to exploit motion the atlas
      // cannot represent. Only when both fail does this become a new tile.
      const hit = atlas.find(tile, frame, opts.atlasMaxPx, opts.atlasMaxMean);
      if (hit >= 0) {
        decided[bi] = { index: bi, mode: MODE.ATLAS, atlasPos: hit };
        atlasBlocks++;
        continue;
      }
      const pos = atlas.alloc(frame);
      atlas.store(tile, pos, frame);
      decided[bi] = { index: bi, mode: MODE.RAW, atlasPos: pos, pixels: tile };
      rawPixels += pxPerBlock;
      continue;
    }
    decided[bi] = { index: bi, mode: MODE.RAW, pixels: tile };
    rawPixels += pxPerBlock;
  }

  // ATLAS blocks cost the same shape of call as MV (one area blit), not rawUs.
  const estimatedMs =
    (rawPixels * opts.rawUs + (mvBlocks + atlasBlocks) * opts.mvUs) / 1000;
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
      if (blk.mode === MODE.ATLAS) {
        const tile = atlas ? atlas.get(blk.atlasPos!) : undefined;
        if (!tile) throw new Error(`encoder: ATLAS position ${blk.atlasPos} empty`);
        for (let y = 0; y < B; y++) {
          next.set(tile.subarray(y * B, y * B + B), (py + y) * g.w + px);
        }
      } else if (blk.mode === MODE.RAW) {
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
      seq: seqStart, flags: 0, blocks, rawPixels, mvBlocks, atlasBlocks,
      skipBlocks: nBlocks - blocks.length, estimatedMs,
    });
    return frames;
  }

  // ---- progressive refresh: part 0 carries all MVs, later parts RAW only.
  // No MV in later parts, because each part ends with a display->prev copy and a
  // later MV would then read already-updated pixels instead of the frame N-1 state.
  const budgetUs = opts.budgetMs * 1000;
  const mvList = decided.filter((d): d is BlockData => d !== null && d.mode === MODE.MV);
  // ATLAS must travel with the RAW blocks, in ascending block order, and never in
  // part 0. Two reasons, both load-bearing:
  //   * a tile is stored at the position sent WITH the RAW block that carries it,
  //     so an ATLAS reference is only valid once that store has been decoded. In
  //     ascending order the store's block index is always smaller than the
  //     reference's, which is exactly the guarantee needed.
  //   * part 0 carries every MV, and each part ends with a display->prev snapshot;
  //     an ATLAS copy in part 0 would be fine for prev but would still have to
  //     respect the store-before-reference rule, which part 0 cannot.
  // Dropping ATLAS here (the earlier bug) silently blanked 137600 pixels on any
  // frame large enough to split.
  const bodyList = decided
    .filter((d): d is BlockData => d !== null && (d.mode === MODE.RAW || d.mode === MODE.ATLAS))
    .sort((a, b) => a.index - b.index);
  const costUs = (blk: BlockData) =>
    blk.mode === MODE.RAW ? pxPerBlock * opts.rawUs : opts.mvUs;

  const parts: BlockData[][] = [];
  let curPart: BlockData[] = [...mvList];
  let curPartPx = 0;
  for (const blk of bodyList) {
    if (curPartPx > 0 && curPartPx + costUs(blk) > budgetUs) {
      parts.push(curPart);
      curPart = [];
      curPartPx = 0;
    }
    curPart.push(blk);
    curPartPx += costUs(blk);
  }
  if (curPart.length > 0) parts.push(curPart);

  for (let k = 0; k < parts.length; k++) {
    const blocks = parts[k];
    const rawPx = blocks.filter((b) => b.mode === MODE.RAW).length * pxPerBlock;
    const mvN = blocks.filter((b) => b.mode === MODE.MV).length;
    // An ATLAS block is one cross-slot area blit, the same shape of cost as MV,
    // so it is estimated with mvUs rather than rawUs.
    const atlN = blocks.filter((b) => b.mode === MODE.ATLAS).length;
    const est = (rawPx * opts.rawUs + (mvN + atlN) * opts.mvUs) / 1000;
    applyGroup(blocks);
    frames.push({
      seq: seqStart + k,
      flags: k === 0 ? FRAME_FLAG_KEY : 0,
      blocks, rawPixels: rawPx, mvBlocks: mvN, atlasBlocks: atlN,
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
  atlas?: TileAtlas,
) {
  const B = cfg.block;
  const bx = Math.ceil(cfg.w / B);
  for (const blk of blocks) {
    const px = (blk.index % bx) * B;
    const py = Math.floor(blk.index / bx) * B;
    if (blk.mode === MODE.ATLAS) {
      // Copy the stored tile. Encoding an ATLAS block whose position still holds
      // nothing would make the CC read a zeroed slot, so this is a hard error
      // rather than a silent blank tile.
      if (!atlas) throw new Error("reference decoder: ATLAS block but no atlas supplied");
      const tile = atlas.get(blk.atlasPos!);
      if (!tile) {
        throw new Error(`reference decoder: ATLAS position ${blk.atlasPos} is empty at block ${blk.index}`);
      }
      for (let y = 0; y < B; y++) {
        dst.set(tile.subarray(y * B, y * B + B), (py + y) * cfg.w + px);
      }
      continue;
    }
    if (blk.mode === MODE.RAW) {
      // A RAW block is drawn and then written into the atlas, in that order: the
      // decoder needs the pixels on screen whether or not it keeps a copy.
      if (atlas && blk.atlasPos !== undefined) atlas.store(blk.pixels!, blk.atlasPos, -1);
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
