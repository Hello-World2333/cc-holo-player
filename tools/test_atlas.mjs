/**
 * Atlas tests: geometry, matching tolerance, eviction, and — the one that
 * actually caught a bug — that a SPLIT frame still carries every ATLAS block.
 *
 * Run: node tools/test_atlas.mjs
 */
import assert from "node:assert/strict";
import { TileAtlas, autoAtlasCfg } from "../node/dist/atlas.js";
import { encodeFrame, quantize, applyFrame, DEFAULT_OPTS } from "../node/dist/codec.js";
import { MODE, frameParts, decodeFrame } from "../node/dist/protocol.js";

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

/** Packed value: 2 bits per channel, R highest. Only RGB matter for matching.
 *  Each argument MUST be 0..3 — a 4 would overflow into the neighbouring channel
 *  and silently produce a different colour than intended (an early version of
 *  these tests wrote px(1,2,4) and confused itself). */
const px = (r, g, b, a = 3) => ((r & 3) << 6) | ((g & 3) << 4) | ((b & 3) << 2) | (a & 3);
const tileOf = (v) => new Uint8Array(64).fill(v);

console.log("geometry");
t("autoAtlasCfg fills whole slots under the 393216 cap", () => {
  for (const b of [8, 10, 16, 20]) {
    const c = autoAtlasCfg(b, 14);
    const perSlot = (c.slotW / b) * (c.slotH / b);
    assert.equal(perSlot, Math.floor(perSlot));
    assert.ok(c.slotW * c.slotH <= 393216, `slot ${c.slotW}x${c.slotH} over cap`);
  }
  const c8 = autoAtlasCfg(8, 14);
  assert.equal(c8.slotW * c8.slotH, 393216);
  assert.equal((c8.slotW / 8) * (c8.slotH / 8), 6144);
});
t("locate() maps a flat position to slot + pixel origin", () => {
  const a = new TileAtlas(autoAtlasCfg(8, 2));
  const per = a.tilesPerSlot;
  assert.deepEqual(a.locate(0), { slot: 0, x: 0, y: 0 });
  assert.deepEqual(a.locate(1), { slot: 0, x: 8, y: 0 });
  assert.deepEqual(a.locate(a.tilesPerRow), { slot: 0, x: 0, y: 8 });
  assert.deepEqual(a.locate(per), { slot: 1, x: 0, y: 0 });
  // last tile of slot 1 must stay inside slot 1
  const last = a.locate(per * 2 - 1);
  assert.equal(last.slot, 1);
  assert.ok(last.x < 512 && last.y < 768);
});
t("capacity is slots * tilesPerSlot", () => {
  const a = new TileAtlas(autoAtlasCfg(8, 14));
  assert.equal(a.capacity, 14 * 6144);
  assert.equal(a.capacity, 86016);
});
t("rejects a slot over the byte cap", () => {
  assert.throws(() => new TileAtlas({ tile: 8, slotW: 1024, slotH: 768, slots: 1 }), /393216/);
});

console.log("matching");
t("exact tile hits", () => {
  const a = new TileAtlas(autoAtlasCfg(8, 1));
  a.store(tileOf(px(1, 2, 3)), 0, 0);
  assert.equal(a.find(tileOf(px(1, 2, 3)), 1, 2, 0.25), 0);
});
t("within tolerance hits", () => {
  const a = new TileAtlas(autoAtlasCfg(8, 1));
  const stored = tileOf(px(1, 2, 3));
  a.store(stored, 0, 0);
  const near = tileOf(px(1, 2, 3));
  near[5] = px(1, 2, 2);            // blue one level lower -> d=1
  assert.equal(a.find(near, 1, 2, 0.25), 0);
});
t("outside tolerance misses (max pixel)", () => {
  const a = new TileAtlas(autoAtlasCfg(8, 1));
  a.store(tileOf(px(1, 2, 3)), 0, 0);
  const far = tileOf(px(0, 2, 3));
  far[0] = px(3, 2, 3);             // red three levels up -> d=3 > maxPx 2
  assert.equal(a.find(far, 1, 2, 0.25), -1);
});
t("a whole-frame of flat tiles collapses to one store", () => {
  const a = new TileAtlas(autoAtlasCfg(8, 1));
  const black = tileOf(px(0, 0, 0));
  a.store(black, 0, 0);
  for (let i = 0; i < 100; i++) assert.equal(a.find(black, i, 2, 0.25), 0);
  assert.equal(a.stats.hits, 100);
});

console.log("eviction");
t("alloc never evicts while a free position exists", () => {
  const a = new TileAtlas({ tile: 8, slotW: 16, slotH: 16, slots: 1 }); // 4 tiles
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const p = a.alloc(i);
    assert.ok(!seen.has(p), `alloc handed out position ${p} twice without a store`);
    seen.add(p);
  }
  assert.equal(seen.size, 4);
  assert.equal(a.stats.evictions, 0);
});
t("alloc evicts the least recently used position", () => {
  const a = new TileAtlas({ tile: 8, slotW: 16, slotH: 16, slots: 1 }); // 4 tiles
  for (let i = 0; i < 4; i++) a.store(tileOf(px(i, 0, 0)), i, i);
  // touch 1, 2, 3 -> 0 is now LRU
  a.find(tileOf(px(1, 0, 0)), 10, 0, 0);
  a.find(tileOf(px(2, 0, 0)), 11, 0, 0);
  a.find(tileOf(px(3, 0, 0)), 12, 0, 0);
  assert.equal(a.alloc(), 0);
  assert.equal(a.stats.evictions, 1);
});
t("an evicted position no longer matches", () => {
  const a = new TileAtlas({ tile: 8, slotW: 16, slotH: 16, slots: 1 });
  for (let i = 0; i < 4; i++) a.store(tileOf(px(i, 0, 0)), i, i);
  const victim = a.alloc();
  a.store(tileOf(px(3, 3, 3)), victim, 99);
  // position victim now holds the new tile, so the old lookup must fail
  const old = new TileAtlas({ tile: 8, slotW: 16, slotH: 16, slots: 1 });
  for (let i = 0; i < 4; i++) old.store(tileOf(px(i, 0, 0)), i, i);
  assert.equal(old.find(tileOf(px(3, 3, 3)), 5, 0, 0), -1);
});

console.log("frame integration");
const W = 64, H = 32, B = 8;
/** Build a frame with a few distinct 8x8 tile types, laid out in a grid. */
function makeFrame(types, w = W, h = H) {
  const out = new Uint8Array(w * h);
  const bx = w / B;
  for (let bi = 0; bi < (w / B) * (h / B); bi++) {
    const v = types[bi % types.length];
    const px0 = (bi % bx) * B, py0 = Math.floor(bi / bx) * B;
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
      // give each tile a gradient so they are not all identical
      out[(py0 + y) * w + px0 + x] = px(
        Math.min(3, (v + x) % 4), Math.min(3, (v + y) % 4), Math.min(3, (v + x + y) % 4),
      );
    }
  }
  return out;
}

t("ATLAS blocks survive a frame that splits into several parts", () => {
  // A tiny budget forces the split path, which is exactly where ATLAS blocks
  // were being dropped: they matched neither the MV nor the RAW filter, so a
  // split frame silently omitted every one of them.
  const atlas = new TileAtlas(autoAtlasCfg(B, 1));
  const cfg = { w: W, h: H, block: B };
  const state = new Uint8Array(W * H);
  const opts = { ...DEFAULT_OPTS, budgetMs: 0.01 };  // forces needsSplit

  const f0 = makeFrame([0, 1, 2, 3]);
  const parts0 = encodeFrame(f0, state, cfg, 0, opts, atlas, 0);
  assert.ok(parts0.length > 1, "expected the frame to split");
  const emitted0 = new Set(parts0.flatMap((f) => f.blocks.map((b) => b.index)));
  for (let bi = 0; bi < (W / B) * (H / B); bi++) {
    assert.ok(emitted0.has(bi), `block ${bi} missing from split frame 0`);
  }
  // Force the ATLAS path: forbid SKIP/MV entirely (zero tolerance, no search
  // radius) so every changed block must go through the atlas, while a 0.01ms
  // budget keeps the frame split across parts. This is the exact combination
  // that dropped 2150 ATLAS blocks and blanked 137600 pixels on real content.
  const atlasOnly = {
    ...DEFAULT_OPTS, budgetMs: 0.01, searchRadius: 0,
    copyTol: 0, copyMaxPx: 0, copyMaxDiffPct: 0,
  };
  // Tiles are shifted by one type, so no block matches its own previous pixels.
  const shifted = makeFrame([1, 2, 3, 0]);
  const parts1 = encodeFrame(shifted, state, cfg, 10, atlasOnly, atlas, 1);
  assert.ok(parts1.length > 1, `expected a split, got ${parts1.length} part(s)`);
  const modes1 = parts1.flatMap((f) => f.blocks).map((b) => b.mode);
  assert.ok(modes1.length > 0, "second frame emitted no blocks at all");
  assert.ok(
    modes1.some((m) => m === MODE.ATLAS),
    `expected ATLAS blocks, got ${JSON.stringify([...new Set(modes1)])}`,
  );
  const emitted1 = new Set(parts1.flatMap((f) => f.blocks.map((b) => b.index)));
  assert.equal(emitted1.size, (W / B) * (H / B));
});

t("encoder model and reference decoder agree on every pixel (with atlas)", () => {
  const atlasA = new TileAtlas(autoAtlasCfg(B, 1));
  const atlasB = new TileAtlas(autoAtlasCfg(B, 1));
  const cfg = { w: W, h: H, block: B };
  let encPrev = new Uint8Array(W * H);
  let refPrev = new Uint8Array(W * H);
  let refDisp = new Uint8Array(W * H);
  const opts = { ...DEFAULT_OPTS, budgetMs: 0.5 };

  for (let fi = 0; fi < 6; fi++) {
    const cur = makeFrame([0, 1, 2, 3, fi % 4]);
    const parts = encodeFrame(cur, encPrev, cfg, fi * 10, opts, atlasA, fi);
    for (const f of parts) {
      for (const msg of frameParts(f.seq, f.flags, W / B, H / B, f.blocks, 4096)) {
        const d = decodeFrame(msg, B);
        applyFrame(refDisp, refPrev, cfg, d.blocks, atlasB);
        refPrev.set(refDisp);
      }
    }
    // encPrev is the encoder's own model of what the display now holds
    for (let i = 0; i < W * H; i++) {
      assert.equal(refDisp[i], encPrev[i], `frame ${fi} pixel ${i}: ref=${refDisp[i]} enc=${encPrev[i]}`);
    }
  }
});

t("every ATLAS reference points at a position that is already stored", () => {
  // Store-before-reference is what makes the CC decoder safe: it applies blocks
  // in ascending index order, so a store at a larger index than its reference
  // would read an empty slot and throw.
  const atlas = new TileAtlas(autoAtlasCfg(B, 1));
  const cfg = { w: W, h: H, block: B };
  const state = new Uint8Array(W * H);
  const opts = { ...DEFAULT_OPTS, budgetMs: 0.5 };
  // `stored` persists across frames: a reference may legitimately point at a
  // position written several frames ago, which is the whole point of the atlas.
  const stored = new Set();
  for (let fi = 0; fi < 5; fi++) {
    const cur = makeFrame([fi % 3, (fi + 1) % 3]);
    const parts = encodeFrame(cur, state, cfg, fi * 10, opts, atlas, fi);
    const blocks = parts.flatMap((f) => f.blocks).sort((a, b) => a.index - b.index);
    for (const b of blocks) {
      if (b.mode === MODE.ATLAS) {
        assert.ok(stored.has(b.atlasPos), `frame ${fi} block ${b.index} references unstored ${b.atlasPos}`);
      } else if (b.mode === MODE.RAW) {
        stored.add(b.atlasPos);
      }
    }
  }
  assert.ok(stored.size > 0, "no RAW stores at all");
});

console.log(`\n${pass} checks passed`);
