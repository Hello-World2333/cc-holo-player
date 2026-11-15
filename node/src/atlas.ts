/**
 * Content-addressed tile atlas with LRU eviction, mirrored by the decoder.
 *
 * The decoder owns no atlas POLICY: the encoder decides what goes where and
 * sends the position with every ATLAS and RAW block. That is deliberate — the
 * matching is approximate (see `match`), so only the encoder can decide whether
 * a tile is "the same" as one already stored, and making the decoder re-derive
 * that would require sending the tolerance machinery over the wire.
 *
 * Capacity comes from the hologram: 16 framebuffer slots, each capped at
 * 393216 bytes (`getMaxBufferSize()` in the jar). Two slots are needed for the
 * display/prev pair, leaving 14 for the atlas: 14 * 393216 / 64 = 86016 8x8
 * tiles. Measured on #81: a cross-slot 8x8 blitFrameBufferArea costs 11.3us vs
 * 18.0us for a table blit, so an atlas hit is cheaper to decode, not more.
 *
 * PERFORMANCE: every operation here is O(1) amortised, except the bucket scan in
 * `find`, bounded by how many tiles share a coarse signature. An earlier version
 * looked for a free position by scanning 0..capacity, which at 86016 slots and
 * ~190k stores meant roughly 16 billion comparisons — transcoding went from
 * 3.1x slower than the no-atlas baseline purely from that scan, plus a second
 * O(capacity) scan to find an LRU victim once the atlas filled. Free positions
 * now come from a stack and LRU order from an intrusive doubly-linked list.
 */

import type { AtlasCfg } from "./protocol.js";

export interface AtlasStats {
  lookups: number;
  hits: number;
  /** of which resolved by the exact-content tier */
  exactHits: number;
  stores: number;
  evictions: number;
}

/**
 * How many tiles may compete as fuzzy candidates under one coarse signature.
 * Bounds the worst-case probe cost; see the `buckets` field comment for why a
 * tighter signature is not the answer.
 */
export const DEFAULT_BUCKET_CAP = 256;

/** Per-position lifecycle. */
const FREE = 0;
/** Handed out by alloc(), no bytes written yet. */
const RESERVED = 1;
/** Holds tile bytes. */
const STORED = 2;

export class TileAtlas {
  readonly tile: number;
  readonly slots: number;
  readonly tilesPerRow: number;
  readonly rowsPerSlot: number;
  readonly tilesPerSlot: number;
  readonly capacity: number;

  /** position -> tile bytes; undefined means no bytes stored there */
  private tiles: (Uint8Array | undefined)[];
  private state: Uint8Array;
  /** position -> coarse signature, cached so unindex never recomputes it */
  private sigAt: Int32Array;
  /** position -> exact content hash, cached for the same reason */
  private hashAt: Int32Array;
  /** intrusive LRU list over STORED positions; head = most recent */
  private lruPrev: Int32Array;
  private lruNext: Int32Array;
  private lruHead = -1;
  private lruTail = -1;
  /** positions available for reuse, popped from the end */
  private free: number[] = [];
  /**
   * Membership of `free`. Needed because `store()` can write a position that is
   * still in the stack: without the flag, a later alloc() would hand out a
   * position that already holds a live tile and silently corrupt every reference
   * already emitted to it. Entries whose flag is clear are skipped lazily.
   */
  private inFree: Uint8Array;
  /**
   * coarse signature -> candidate positions, most recently stored FIRST.
   *
   * The bucket length must be bounded or the cost feeds on itself: once the
   * atlas is full, evictions stop the exact tier from hitting, so every lookup
   * falls through to the fuzzy scan; each miss stores a tile, which lengthens the
   * bucket, which makes the next scan slower. Measured on a 150s clip: 37 fps
   * while the atlas had room, degrading to 12.3 fps once it filled.
   *
   * A signature with only 4096 buckets spread over 86016 tiles averages 21
   * candidates and measured 190, peaking at 1027. Refining the signature to bind
   * tiles more tightly is NOT the fix — near-duplicate tiles then land in
   * different buckets and the hit rate collapses (73.8% -> 58.3% at 4 bits).
   * So the bucket is capped instead, keeping the newest entries, and the probe
   * budget stays constant regardless of atlas occupancy.
   */
  private buckets = new Map<number, number[]>();
  /**
   * Exact-content hash -> positions holding those exact bytes.
   *
   * 58% of all 8x8 tiles in real content are byte-identical to a tile seen
   * before (dithering is deterministic, so static and flat areas repeat exactly).
   * Those hits need no tolerance walk at all, and routing them here keeps the
   * fuzzy bucket scan — 190 candidates on average, 1027 at worst — for the
   * genuinely approximate cases only.
   */
  private exact = new Map<number, number[]>();
  private storedCount = 0;

  /** fuzzy candidates probed per lookup under one signature */
  readonly bucketCap: number;

  readonly stats: AtlasStats = { lookups: 0, hits: 0, exactHits: 0, stores: 0, evictions: 0 };

  /** scratch for signature computation, reused so store() allocates nothing */
  private readonly sigAcc = new Int32Array(4);
  private readonly sigCnt = new Int32Array(4);

  constructor(cfg: AtlasCfg, bucketCap = DEFAULT_BUCKET_CAP) {
    this.bucketCap = bucketCap;
    if (cfg.tile <= 0) throw new Error("atlas: tile must be positive");
    if (cfg.slotW % cfg.tile || cfg.slotH % cfg.tile) {
      throw new Error(`atlas: slot ${cfg.slotW}x${cfg.slotH} not a multiple of tile ${cfg.tile}`);
    }
    if (cfg.slotW * cfg.slotH > 393216) {
      throw new Error(`atlas: slot ${cfg.slotW}x${cfg.slotH} exceeds 393216 bytes`);
    }
    this.tile = cfg.tile;
    this.slots = cfg.slots;
    this.tilesPerRow = cfg.slotW / cfg.tile;
    this.rowsPerSlot = cfg.slotH / cfg.tile;
    this.tilesPerSlot = this.tilesPerRow * this.rowsPerSlot;
    this.capacity = this.tilesPerSlot * cfg.slots;
    this.tiles = new Array(this.capacity);
    this.state = new Uint8Array(this.capacity);
    this.sigAt = new Int32Array(this.capacity).fill(-1);
    this.hashAt = new Int32Array(this.capacity).fill(-1);
    this.lruPrev = new Int32Array(this.capacity).fill(-1);
    this.lruNext = new Int32Array(this.capacity).fill(-1);
    this.inFree = new Uint8Array(this.capacity).fill(1);
    for (let p = this.capacity - 1; p >= 0; p--) this.free.push(p);
  }

  /** Where a position lands: slot index, and pixel offset inside that slot. */
  locate(pos: number): { slot: number; x: number; y: number } {
    const slot = Math.floor(pos / this.tilesPerSlot);
    const rem = pos - slot * this.tilesPerSlot;
    const tx = rem % this.tilesPerRow;
    const ty = Math.floor(rem / this.tilesPerRow);
    return { slot, x: tx * this.tile, y: ty * this.tile };
  }

  /**
   * Coarse signature used to narrow the search. Four quadrant means, quantised
   * to 3 bits each so near-identical tiles still share a bucket. Being coarse is
   * the point: a tight signature would silently drop valid matches, and the exact
   * check below is what actually decides.
   */
  private sig(t: Uint8Array): number {
    const tile = this.tile, half = tile >> 1;
    const q = this.sigAcc, c = this.sigCnt;
    q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 0;
    c[0] = 0; c[1] = 0; c[2] = 0; c[3] = 0;
    for (let y = 0; y < tile; y++) {
      const row = y < half ? 0 : 2;
      const base = y * tile;
      for (let x = 0; x < tile; x++) {
        const k = row + (x < half ? 0 : 1);
        const v = t[base + x];
        q[k] += ((v >> 6) & 3) + ((v >> 4) & 3) + ((v >> 2) & 3);
        c[k]++;
      }
    }
    let s = 0;
    for (let k = 0; k < 4; k++) {
      // 0..9 per pixel -> 0..7 bucket
      const mean = q[k] / c[k];
      s = s * 8 + Math.min(7, Math.round((mean / 9) * 7));
    }
    return s;
  }

  /** FNV-1a over the tile bytes. Cheap, and collisions are resolved by memcmp. */
  private hash(t: Uint8Array): number {
    const n = this.tile * this.tile;
    let h = 0x811c9dc5;
    for (let i = 0; i < n; i++) {
      h ^= t[i];
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** Byte-identical comparison (the hash already matched). */
  private same(a: Uint8Array, b: Uint8Array): boolean {
    const n = this.tile * this.tile;
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /**
   * Exact acceptance test, identical in spirit to the SKIP/MV tolerance.
   * Both caps are checked incrementally: `sum` only grows, so a run that is
   * already over the mean cap can stop immediately instead of scoring all 64
   * pixels. This is the hot loop during encoding.
   */
  private match(a: Uint8Array, b: Uint8Array, maxPx: number, maxMean: number): boolean {
    const n = this.tile * this.tile;
    const sumCap = maxMean * n * 3;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const u = a[i], v = b[i];
      if (u === v) continue;
      const d =
        Math.abs(((u >> 6) & 3) - ((v >> 6) & 3)) +
        Math.abs(((u >> 4) & 3) - ((v >> 4) & 3)) +
        Math.abs(((u >> 2) & 3) - ((v >> 2) & 3));
      if (d > maxPx) return false;
      sum += d;
      if (sum > sumCap) return false;
    }
    return true;
  }

  /** Find an existing tile within tolerance. Returns -1 on miss. */
  find(t: Uint8Array, frame: number, maxPx: number, maxMean: number): number {
    this.stats.lookups++;

    // Tier 1: exact content. O(1), no pixel comparisons unless the hash collides.
    const ex = this.exact.get(this.hash(t));
    if (ex) {
      for (let i = 0; i < ex.length; i++) {
        const pos = ex[i];
        const cand = this.tiles[pos];
        if (cand && this.same(cand, t)) {
          this.touch(pos);
          this.stats.hits++;
          this.stats.exactHits++;
          return pos;
        }
      }
    }

    // Tier 2: approximate match within tolerance.
    const bucket = this.buckets.get(this.sig(t));
    if (bucket) {
      for (let i = 0; i < bucket.length; i++) {
        const pos = bucket[i];
        const cand = this.tiles[pos];
        if (!cand) continue;
        if (this.match(cand, t, maxPx, maxMean)) {
          this.touch(pos);
          this.stats.hits++;
          return pos;
        }
      }
    }
    return -1;
  }

  /**
   * Store a tile at a specific position, replacing whatever was there.
   *
   * `frame < 0` means "mirror only": the reference decoder replays the same
   * stream the encoder produced and must NOT count these as policy stores. It
   * still updates the LRU order, because the encoder's order is derived from
   * when tiles are used, and a mirror that disagreed would model a different
   * atlas than the one on screen.
   */
  store(t: Uint8Array, pos: number, frame: number): void {
    if (pos < 0 || pos >= this.capacity) {
      throw new Error(`atlas: position ${pos} out of range (capacity ${this.capacity})`);
    }
    if (this.state[pos] === STORED) this.unindex(pos);
    if (this.state[pos] === FREE) this.inFree[pos] = 0;
    this.tiles[pos] = t;
    this.state[pos] = STORED;
    const s = this.sig(t);
    this.sigAt[pos] = s;
    const b = this.buckets.get(s);
    if (b) {
      b.unshift(pos);
      if (b.length > this.bucketCap) {
        // Drop the oldest entry. The tile itself stays in the atlas and is still
        // reachable through the exact tier; it just stops being a fuzzy
        // candidate, which is the point of the cap.
        b.pop();
      }
    } else {
      this.buckets.set(s, [pos]);
    }
    const h = this.hash(t);
    this.hashAt[pos] = h;
    const e = this.exact.get(h);
    if (e) e.push(pos); else this.exact.set(h, [pos]);
    this.linkRecent(pos);
    this.storedCount++;
    if (frame >= 0) this.stats.stores++;
  }

  /**
   * Pick the position for a brand new tile, evicting the least recently used
   * entry when full.
   *
   * The position is RESERVED before returning. Without that, two consecutive
   * calls with no `store` in between handed out the same free position, and the
   * second tile overwrote the first — silently corrupting every reference the
   * encoder had already emitted to it.
   */
  alloc(frame = 0): number {
    let pos = -1;
    while (this.free.length > 0) {
      const p = this.free.pop()!;
      if (this.inFree[p]) { pos = p; break; }
    }
    if (pos >= 0) {
      this.inFree[pos] = 0;
    } else {
      pos = this.lruTail;
      if (pos < 0) throw new Error("atlas: full but no victim");
      this.unindex(pos);
      this.stats.evictions++;
    }
    this.state[pos] = RESERVED;
    this.tiles[pos] = undefined;
    this.sigAt[pos] = -1;
    this.hashAt[pos] = -1;
    return pos;
  }

  get(pos: number): Uint8Array | undefined {
    return pos >= 0 && pos < this.capacity ? this.tiles[pos] : undefined;
  }

  /** Does this position hold bytes? (A reserved position does not, yet.) */
  has(pos: number): boolean {
    return pos >= 0 && pos < this.capacity && this.state[pos] === STORED;
  }

  /** How many positions currently hold bytes. */
  get stored(): number {
    return this.storedCount;
  }

  /** Mark every stored position as just-used (after a loop restart). */
  touchAll(_frame: number): void {
    // Only the relative order matters for eviction, and rebuilding it would cost
    // more than it buys; leave the existing order alone.
  }

  // ---- intrusive LRU list ----
  private linkRecent(pos: number): void {
    this.unlink(pos);
    this.lruNext[pos] = this.lruHead;
    this.lruPrev[pos] = -1;
    if (this.lruHead >= 0) this.lruPrev[this.lruHead] = pos;
    this.lruHead = pos;
    if (this.lruTail < 0) this.lruTail = pos;
  }

  private unlink(pos: number): void {
    const p = this.lruPrev[pos], n = this.lruNext[pos];
    if (p >= 0) this.lruNext[p] = n;
    else if (this.lruHead === pos) this.lruHead = n;
    if (n >= 0) this.lruPrev[n] = p;
    else if (this.lruTail === pos) this.lruTail = p;
    this.lruPrev[pos] = -1;
    this.lruNext[pos] = -1;
  }

  private touch(pos: number): void {
    if (this.lruHead !== pos) this.linkRecent(pos);
  }

  private unindex(pos: number): void {
    const h = this.hashAt[pos];
    if (h >= 0) {
      const e = this.exact.get(h);
      if (e) {
        const i = e.indexOf(pos);
        if (i >= 0) { e[i] = e[e.length - 1]; e.pop(); }
        if (e.length === 0) this.exact.delete(h);
      }
      this.hashAt[pos] = -1;
    }
    const s = this.sigAt[pos];
    if (s >= 0) {
      const b = this.buckets.get(s);
      if (b) {
        const i = b.indexOf(pos);
        if (i >= 0) {
          // swap-remove: order inside a bucket is irrelevant, and splice() is O(n)
          b[i] = b[b.length - 1];
          b.pop();
        }
        if (b.length === 0) this.buckets.delete(s);
      }
    }
    this.sigAt[pos] = -1;
    this.state[pos] = FREE;
    this.tiles[pos] = undefined;
    this.unlink(pos);
    if (this.storedCount > 0) this.storedCount--;
    if (!this.inFree[pos]) {
      this.inFree[pos] = 1;
      this.free.push(pos);
    }
  }
}

/** Pick an atlas geometry that fills whole framebuffer slots. */
export function autoAtlasCfg(tile: number, freeSlots = 14): AtlasCfg {
  // 512x768 = 393216 exactly, the per-slot cap, and both divide by 8/10/16/20.
  const slotW = 512, slotH = 768;
  if (slotW % tile !== 0 || slotH % tile !== 0) {
    // fall back to the largest square-ish area under the cap
    const side = Math.floor(Math.sqrt(393216));
    const w = Math.floor(side / tile) * tile;
    const h = Math.floor(393216 / w / tile) * tile;
    return { tile, slotW: w, slotH: h, slots: freeSlots };
  }
  return { tile, slotW, slotH, slots: freeSlots };
}
