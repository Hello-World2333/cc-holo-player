#!/usr/bin/env node
/**
 * Render a decoded frame to PNG so a human can look at it.
 *
 * Written because aggregate metrics lied: the encoder reported a mean error of
 * 0.115 levels per channel — indistinguishable from perfect — while the actual
 * screen was covered in block-shaped ghosting. Means are blind to isolated large
 * errors by construction, and the visual system is maximally sensitive to
 * exactly those. No number replaces looking at the picture.
 *
 *   node tools/render_frames.mjs <video> <seekSec> <maxPx> <maxDiff> <copyTol> <dither> <outPrefix>
 *
 * Produces <outPrefix>-src.png (source quantized without dither) and
 * <outPrefix>-recon.png (what the CC will actually display).
 */
import { spawn } from "node:child_process";
import { encodeFrame, quantize, DEFAULT_OPTS } from "../node/dist/codec.js";

const W = 640, H = 360, B = 20, FB = W * H * 3;
const LV = [0, 85, 170, 255];

const [VID, SS, MX, DF, TOL, DITH, OUT] = process.argv.slice(2);
if (!OUT) {
  console.error("usage: render_frames.mjs <video> <seek> <maxPx> <maxDiff> <copyTol> <dither> <outPrefix>");
  process.exit(1);
}

const data = await new Promise((res) => {
  const ff = spawn("ffmpeg", [
    "-v", "error", "-ss", SS, "-t", "3", "-i", VID,
    "-vf", `scale=${W}:${H}:flags=area`, "-r", "20",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  const b = [];
  ff.stdout.on("data", (c) => b.push(c));
  ff.on("close", () => res(Buffer.concat(b)));
});

const n = Math.floor(data.length / FB);
if (n === 0) { console.error("no frames decoded"); process.exit(1); }

const toRGB = (buf) => {
  const o = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const v = buf[i];
    o[i * 3] = LV[(v >> 6) & 3];
    o[i * 3 + 1] = LV[(v >> 4) & 3];
    o[i * 3 + 2] = LV[(v >> 2) & 3];
  }
  return o;
};

const opts = {
  ...DEFAULT_OPTS,
  copyMaxPx: +MX,
  copyMaxDiffPct: +DF,
  copyTol: +TOL,
};

// Run the whole clip so SKIP/MV accumulate exactly as they would in playback;
// rendering only the last frame after a cold start would show a keyframe.
let state = new Uint8Array(W * H);
let lastRaw = null;
for (let fi = 0; fi < n; fi++) {
  const raw = data.subarray(fi * FB, (fi + 1) * FB);
  const cur = quantize(raw, W, H, { dither: DITH });
  encodeFrame(cur, state, { w: W, h: H, block: B }, fi, opts);
  lastRaw = raw;
}

const cur = quantize(lastRaw, W, H, { dither: DITH });
const src = quantize(lastRaw, W, H, { dither: "none" });

let diffPx = 0, worst = 0;
for (let i = 0; i < W * H; i++) {
  const a = state[i], b = cur[i];
  if (a === b) continue;
  diffPx++;
  const d =
    Math.abs(((a >> 6) & 3) - ((b >> 6) & 3)) +
    Math.abs(((a >> 4) & 3) - ((b >> 4) & 3)) +
    Math.abs(((a >> 2) & 3) - ((b >> 2) & 3));
  if (d > worst) worst = d;
}

for (const [name, buf] of [["src", src], ["recon", state]]) {
  const ff = spawn("ffmpeg", [
    "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`,
    "-i", "-", "-y", `${OUT}-${name}.png`,
  ], { stdio: ["pipe", "ignore", "inherit"] });
  ff.stdin.end(toRGB(buf));
  await new Promise((r) => ff.on("close", r));
}

console.error(
  `${OUT}: ${diffPx} px differ (${(diffPx / (W * H) * 100).toFixed(1)}%), ` +
  `worst pixel = ${worst} levels`,
);
