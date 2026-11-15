#!/usr/bin/env node
/**
 * Measure what dithering actually buys and what it costs.
 *
 *   node tools/dither_eval.mjs <video> [--frames 60] [--w 640] [--h 360]
 *
 * Two numbers per mode:
 *
 *  * tile error — mean over 8x8 tiles of |mean(source) - mean(reconstructed)|,
 *    in 0..255 units, averaged across R/G/B. This is the metric that matters for
 *    dithering: the eye integrates neighbouring pixels, so what reads as
 *    "banding" is exactly the tile-level average being wrong. Per-pixel error
 *    goes UP with dithering by construction and says nothing useful.
 *
 *  * level flips — share of channel-levels that differ from plain nearest-level
 *    rounding. This is what the codec pays for: the MV/SKIP tests compare packed
 *    bytes exactly, so every flip is a pixel the previous frame can no longer
 *    predict. Reported here so the bitrate measurement has a mechanism, not just
 *    a number.
 *
 * No Lua, no hologram, no full transcode: pure arithmetic over decoded frames.
 */
import { spawn } from "node:child_process";
import { quantize } from "../node/dist/codec.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def === undefined) throw new Error(`missing --${name}`);
  return def;
}

const inPath = process.argv[2];
if (!inPath || inPath.startsWith("--")) {
  console.error("usage: dither_eval.mjs <video> [--frames N] [--w 640] [--h 360]");
  process.exit(1);
}
const FRAMES = parseInt(arg("frames", "60"), 10);
const W = parseInt(arg("w", "640"), 10);
const H = parseInt(arg("h", "360"), 10);
const TILE = 8;

const MODES = [
  { mode: "none", strength: 1, label: "none" },
  { mode: "bayer4", strength: 1, label: "bayer4" },
  { mode: "bayer8", strength: 1, label: "bayer8" },
  { mode: "bayer8", strength: 0.5, label: "bayer8@0.5" },
  { mode: "bayer8", strength: 0.75, label: "bayer8@0.75" },
  { mode: "fs", strength: 1, label: "fs" },
];

const FRAME_BYTES = W * H * 3;
const tiles = (W / TILE) * (H / TILE);

const acc = MODES.map(() => ({ tileSum: 0, flipSum: 0, pxSum: 0, frames: 0 }));

const ff = spawn("ffmpeg", [
  "-v", "error",
  "-i", inPath,
  "-vf", `scale=${W}:${H}:flags=area`,
  "-r", "20",
  "-frames:v", String(FRAMES),
  "-f", "rawvideo", "-pix_fmt", "rgb24",
  "-",
], { stdio: ["ignore", "pipe", "inherit"] });

let buf = Buffer.alloc(0);

ff.stdout.on("data", (chunk) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  while (buf.length >= FRAME_BYTES) {
    const rgb = buf.subarray(0, FRAME_BYTES);
    buf = buf.subarray(FRAME_BYTES);

    const base = quantize(rgb, W, H, { dither: "none" });

    MODES.forEach((m, mi) => {
      const qz = m.mode === "none" && m.strength === 1
        ? base
        : quantize(rgb, W, H, { dither: m.mode, strength: m.strength });
      const a = acc[mi];

      // tile-level average error, per channel
      for (let ty = 0; ty < H / TILE; ty++) {
        for (let tx = 0; tx < W / TILE; tx++) {
          let sR = 0, sG = 0, sB = 0, oR = 0, oG = 0, oB = 0;
          for (let y = 0; y < TILE; y++) {
            const row = (ty * TILE + y) * W + tx * TILE;
            for (let x = 0; x < TILE; x++) {
              const p = (row + x) * 3;
              const v = qz[row + x];
              sR += rgb[p]; sG += rgb[p + 1]; sB += rgb[p + 2];
              oR += (v >> 6) & 3; oG += (v >> 4) & 3; oB += (v >> 2) & 3;
            }
          }
          const n = TILE * TILE;
          a.tileSum +=
            (Math.abs(sR / n - (oR / n) * 85) +
             Math.abs(sG / n - (oG / n) * 85) +
             Math.abs(sB / n - (oB / n) * 85)) / 3;
        }
      }

      // level flips against plain rounding (packed bytes differ => unpredictable)
      let flips = 0;
      for (let i = 0; i < W * H; i++) if (qz[i] !== base[i]) flips++;
      a.flipSum += flips;

      // per-pixel squared error, for PSNR
      let se = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = (y * W + x) * 3;
          const v = qz[y * W + x];
          const dR = rgb[p] - ((v >> 6) & 3) * 85;
          const dG = rgb[p + 1] - ((v >> 4) & 3) * 85;
          const dB = rgb[p + 2] - ((v >> 2) & 3) * 85;
          se += dR * dR + dG * dG + dB * dB;
        }
      }
      a.pxSum += se / (W * H * 3);
      a.frames++;
    });
  }
});

ff.on("close", (code) => {
  if (code !== 0) { console.error(`ffmpeg exited ${code}`); process.exit(1); }
  const frames = acc[0].frames;
  if (frames === 0) { console.error("no frames decoded"); process.exit(1); }

  console.log(`${inPath}  ${W}x${H}  ${frames} frames  tile=${TILE}x${TILE}\n`);
  console.log("mode            tileErr   PSNR    flips   vs-none");
  const baseTile = acc[0].tileSum / frames / tiles;
  const baseFlips = acc[0].flipSum / frames / (W * H);
  MODES.forEach((m, mi) => {
    const a = acc[mi];
    const tileErr = a.tileSum / frames / tiles;
    const mse = a.pxSum / frames;
    const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
    const flips = a.flipSum / frames / (W * H);
    const gain = baseTile === 0 ? 0 : (1 - tileErr / baseTile) * 100;
    console.log(
      `${m.label.padEnd(14)}  ${tileErr.toFixed(3).padStart(7)}  ` +
      `${psnr.toFixed(2).padStart(6)}  ${(flips * 100).toFixed(1).padStart(6)}%  ` +
      `${(m.mode === "none" && m.strength === 1 ? "—" : `tile -${gain.toFixed(0)}%`).padStart(8)}`,
    );
  });
  console.log(
    `\ntileErr = mean |tile mean(source) - tile mean(reconstructed)| over 8x8 tiles (0-255); ` +
    `lower is better.\nPSNR = per-pixel, dithering is expected to make this WORSE — it trades ` +
    `per-pixel accuracy for local average accuracy.\nflips = share of pixels whose level differs ` +
    `from plain rounding; those are pixels MV/SKIP can no longer predict.`,
  );
});
