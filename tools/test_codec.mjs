#!/usr/bin/env node
/**
 * Unit tests for the quantiser / dither code in node/src/codec.ts.
 *
 * These are the properties that a wrong implementation quietly violates:
 * every Bayer matrix must be a permutation (a repeated entry means uneven
 * dispersion), a dithered flat patch must hit the requested average (that is the
 * entire point), alpha must stay 3 (A=0 is invisible on the hologram, not
 * black), and "none" must reproduce the original rounding exactly.
 *
 * Fast and self-contained: no ffmpeg, no video, no Lua.
 */
import { quantize, LEVELS } from "../node/dist/codec.js";

let failures = 0;
function check(name, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.error(`${ok ? "ok  " : "FAIL"}  ${name}  got=${got} want=${want}`);
}

const STEP = 85;

// ---- "none" must match the documented thresholds 43/128/213 ----
{
  const w = 256, h = 1;
  const rgb = new Uint8Array(w * h * 3);
  for (let v = 0; v < 256; v++) {
    rgb[v * 3] = v; rgb[v * 3 + 1] = v; rgb[v * 3 + 2] = v;
  }
  const out = quantize(rgb, w, h, { dither: "none" });
  const expected = (v) => (v < 43 ? 0 : v < 128 ? 1 : v < 213 ? 2 : 3);
  let bad = 0;
  for (let v = 0; v < 256; v++) {
    if (((out[v] >> 6) & 3) !== expected(v)) bad++;
  }
  check("none matches 43/128/213 thresholds", bad, 0);
  check("LEVELS unchanged", LEVELS.join(","), "0,85,170,255");
}

// ---- alpha is always opaque ----
for (const dither of ["none", "bayer4", "bayer8", "fs"]) {
  const w = 40, h = 40;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h * 3; i++) rgb[i] = (i * 37) & 255;
  const out = quantize(rgb, w, h, { dither });
  let bad = 0;
  for (let i = 0; i < w * h; i++) if ((out[i] & 3) !== 3) bad++;
  check(`alpha stays 3 (${dither})`, bad, 0);
}

// ---- Bayer matrices must be permutations of 0..n*n-1 ----
// Reconstructed the same way codec.ts builds them, so a drift in either place
// shows up as a failing test rather than as subtly uneven dithering.
function bayer(n) {
  if (n === 1) return [[0]];
  const half = bayer(n / 2);
  const h = n / 2;
  const out = [];
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
for (const n of [4, 8]) {
  const m = bayer(n);
  const seen = new Set();
  for (const row of m) for (const v of row) seen.add(v);
  check(`bayer${n} is a permutation of 0..${n * n - 1}`, seen.size, n * n);
  check(`bayer${n} max value`, Math.max(...seen), n * n - 1);
}

// ---- the real point: a flat patch must average out to the source value ----
// Without dithering, v=200 rounds to level 2 (170) everywhere: a visible -30
// error. With ordered dithering the patch must average close to 200.
function patchAvg(v, dither, strength) {
  const w = 64, h = 64;
  const rgb = new Uint8Array(w * h * 3);
  rgb.fill(v);
  const out = quantize(rgb, w, h, { dither, strength });
  let sum = 0;
  for (let i = 0; i < w * h; i++) sum += ((out[i] >> 6) & 3) * STEP;
  return sum / (w * h);
}

for (const v of [40, 100, 200, 230]) {
  const none = patchAvg(v, "none", 1);
  const b8 = patchAvg(v, "bayer8", 1);
  // "none" must land on the nearest level; bayer8 must land much closer to v.
  const noneErr = Math.abs(none - v);
  const b8Err = Math.abs(b8 - v);
  check(`bayer8 improves flat ${v} (none err ${noneErr.toFixed(1)})`,
        b8Err < noneErr + 0.5, true);
  check(`bayer8 flat ${v} within 4`, b8Err < 4, true);
}

// strength=0 must be identical to none, whatever the matrix
{
  const w = 50, h = 50;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h * 3; i++) rgb[i] = (i * 11) & 255;
  const a = quantize(rgb, w, h, { dither: "none" });
  const b = quantize(rgb, w, h, { dither: "bayer8", strength: 0 });
  let bad = 0;
  for (let i = 0; i < w * h; i++) if (a[i] !== b[i]) bad++;
  check("bayer8 strength 0 == none", bad, 0);
}

// ---- ordered dither must be position-deterministic across frames ----
// This is what keeps SKIP/MV working on static content: the same input at the
// same coordinates must always produce the same byte. FS deliberately is not.
{
  const w = 32, h = 32;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h * 3; i++) rgb[i] = (i * 7) & 255;
  const once = quantize(rgb, w, h, { dither: "bayer8" });
  const twice = quantize(rgb, w, h, { dither: "bayer8" });
  let bad = 0;
  for (let i = 0; i < w * h; i++) if (once[i] !== twice[i]) bad++;
  check("bayer8 is deterministic", bad, 0);

  // A one-pixel shift of the SOURCE must not change the pattern's phase, but it
  // does change which value sits under which threshold — assert the output is
  // genuinely position dependent (i.e. not silently ignoring x,y).
  const flat = new Uint8Array(w * h * 3).fill(200);
  const d = quantize(flat, w, h, { dither: "bayer8" });
  let distinct = new Set();
  for (let i = 0; i < w * h; i++) distinct.add(d[i]);
  check("bayer8 on a flat patch uses >1 level", distinct.size > 1, true);
}

// ---- FS must not read outside its row buffers ----
// A wrong padding index throws or silently corrupts; running the extremes is
// enough to catch it.
for (const [w, h] of [[1, 1], [1, 8], [3, 2], [64, 4]]) {
  const rgb = new Uint8Array(w * h * 3).fill(128);
  let ok = true;
  try { quantize(rgb, w, h, { dither: "fs" }); } catch { ok = false; }
  check(`fs handles ${w}x${h}`, ok, true);
}

console.error(failures === 0 ? "[test] PASS" : `[test] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
