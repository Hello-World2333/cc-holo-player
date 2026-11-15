#!/usr/bin/env node
/**
 * Offline transcoder: video -> .ccv
 *   node dist/transcode.js --in movie.mp4 --out videos/movie [--fps 20] [--w 640] [--h 360] [--block 16]
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CcvWriter } from "./container.js";
import {
  DEFAULT_OPTS, encodeFrame, quantize, applyFrame, isDitherMode, EncOptions,
  type DitherMode,
} from "./codec.js";
import { VERSION, frameParts, decodeFrame } from "./protocol.js";

const MAX_MSG = 48 * 1024;

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def === undefined) throw new Error(`missing --${name}`);
  return def;
}

const inPath = arg("in");
const outDir = arg("out");
const fps = parseInt(arg("fps", "20"), 10);
const W = parseInt(arg("w", "640"), 10);
const H = parseInt(arg("h", "360"), 10);
const BLOCK = parseInt(arg("block", "20"), 10);
const keyEvery = parseInt(arg("key-every", "0"), 10); // 0 = only first frame
const ditherArg = arg("dither", "bayer8");
if (!isDitherMode(ditherArg)) {
  console.error(`[transcode] FATAL: --dither must be one of none|bayer4|bayer8|fs, got "${ditherArg}"`);
  process.exit(1);
}
const DITHER: DitherMode = ditherArg;
const DITHER_STRENGTH = parseFloat(arg("dither-strength", "1"));

if (W % BLOCK !== 0 || H % BLOCK !== 0) {
  console.error(`[transcode] FATAL: block ${BLOCK} must divide both ${W} and ${H}`);
  process.exit(1);
}

const opts: EncOptions = {
  ...DEFAULT_OPTS,
  mvMad: parseFloat(arg("mv-mad", String(DEFAULT_OPTS.mvMad))),
  budgetMs: parseFloat(arg("budget", String(DEFAULT_OPTS.budgetMs))),
};

fs.mkdirSync(outDir, { recursive: true });
const ccvPath = path.join(outDir, "video.ccv");

const FRAME_BYTES = W * H * 3;

console.error(
  `[transcode] ${inPath} -> ${ccvPath}  ${W}x${H} @${fps}fps block=${BLOCK} ` +
  `dither=${DITHER}${DITHER === "none" ? "" : `@${DITHER_STRENGTH}`}`,
);

const ff = spawn("ffmpeg", [
  "-v", "error",
  "-i", inPath,
  "-vf", `scale=${W}:${H}:flags=area`,
  "-r", String(fps),
  "-f", "rawvideo", "-pix_fmt", "rgb24",
  "-",
], { stdio: ["ignore", "pipe", "inherit"] });

const writer = new CcvWriter(ccvPath, {
  version: VERSION, block: BLOCK, fps,
  wallW: W, wallH: H,
  regionX: 0, regionY: 0, regionW: W, regionH: H,
});

let prev = new Uint8Array(W * H);
// mirror of what the CC is expected to hold, driven by the reference decoder
let refDisplay = new Uint8Array(W * H);
let refPrev = new Uint8Array(W * H);
let mismatch = 0;
let buf: Buffer = Buffer.alloc(0);
let frameIdx = 0;
let seq = 0;
let totalRaw = 0, totalMv = 0, totalSkip = 0, totalMsgs = 0, totalBytes = 0;
const t0 = Date.now();

ff.stdout.on("data", (chunk: Buffer) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  while (buf.length >= FRAME_BYTES) {
    const raw = buf.subarray(0, FRAME_BYTES);
    buf = buf.subarray(FRAME_BYTES);

    // Dithering happens HERE and nowhere else. The CC never learns about it: it
    // receives the same 1-byte-per-pixel format and blits it, so the cost is
    // zero on the decode path and the wire format is unchanged.
    const cur = quantize(raw, W, H, { dither: DITHER, strength: DITHER_STRENGTH });
    const isFirst = frameIdx === 0;
    // force a key frame every `keyEvery` frames, if requested
    const forceKey = isFirst || (keyEvery > 0 && frameIdx % keyEvery === 0);
    if (forceKey) {
      prev = new Uint8Array(W * H); // "no previous frame": force RAW everywhere
      refDisplay = new Uint8Array(W * H);
      refPrev = new Uint8Array(W * H);
    }

    const preSnapA = process.env.DIVERGE_DEBUG ? Uint8Array.from(prev) : null;
    const preSnapB = process.env.DIVERGE_DEBUG ? Uint8Array.from(refPrev) : null;
    const frames = encodeFrame(cur, prev, { w: W, h: H, block: BLOCK }, seq, opts);
    const dbgBlocks = [];
    const timeMs = Math.round((frameIdx * 1000) / fps);

    for (const f of frames) {
      const parts = frameParts(f.seq, f.flags, Math.ceil(W / BLOCK), Math.ceil(H / BLOCK), f.blocks, MAX_MSG);
      for (const p of parts) {
        // Bit-exactness check, run on the BYTES we are about to ship rather than
        // on the encoder's in-memory blocks. The wire format carries no block
        // indices (the decoder re-derives them from the bitmap), so a payload
        // that is not sorted by index decodes into the wrong block — a whole
        // class of bug that an in-memory check cannot see.
        const decoded = decodeFrame(p, BLOCK);
        dbgBlocks.push(...decoded.blocks);
        applyFrame(refDisplay, refPrev, { w: W, h: H, block: BLOCK }, decoded.blocks);

        const partIdx = p.readUInt8(4);
        const partTotal = p.readUInt8(5);
        // The CC only copies display->prev once the whole frame has arrived
        // (wall.lua: `if isLast and pendingParts <= 0 then decoder.snapshot`).
        // Advancing prev per ws-part here made this checker disagree with the
        // real player on frames split over several messages.
        if (partIdx === partTotal - 1) refPrev.set(refDisplay);
        writer.add(p, f.seq, partIdx, partTotal, timeMs);
        totalBytes += p.length;
        totalMsgs++;
      }
      totalRaw += f.rawPixels;
      totalMv += f.mvBlocks;
      totalSkip += f.skipBlocks;
      seq++;
    }

    let diffPx = 0, firstDiff = -1;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== refPrev[i]) {
        diffPx++;
        if (firstDiff < 0) firstDiff = i;
      }
    }
    if (diffPx > 0) {
      mismatch++;
      if (process.env.DIVERGE_DEBUG && mismatch <= 3) {
        const dX = firstDiff % W, dY = Math.floor(firstDiff / W);
        const bi = Math.floor(dY / BLOCK) * Math.ceil(W / BLOCK) + Math.floor(dX / BLOCK);
        const blk = dbgBlocks.find((b) => b.index === bi);
        let preDiff = 0;
        const A = preSnapA, Bs = preSnapB;
        if (A && Bs) {
          for (let i = 0; i < A.length; i++) if (A[i] !== Bs[i]) preDiff++;
        }
        const sX = dX + (blk && blk.dx !== undefined ? blk.dx : 0);
        const sY = dY + (blk && blk.dy !== undefined ? blk.dy : 0);
        console.error(
          `  [diverge] preDiff=${preDiff} src=(${sX},${sY}) ` +
          `encSrc=${A ? A[sY * W + sX] : -1} refSrc=${Bs ? Bs[sY * W + sX] : -1} ` +
          `  [diverge] frame=${frameIdx} seq=${seq} parts=${frames.length} diffPx=${diffPx} ` +
          `first=(${dX},${dY}) block=${bi} mode=${blk ? blk.mode : "absent"} ` +
          `mv=(${blk ? blk.dx : ""},${blk ? blk.dy : ""}) ` +
          `enc=${prev[firstDiff]} ref=${refPrev[firstDiff]} cur=${cur[firstDiff]}`,
        );
      }
    }
    frameIdx++;
    if (frameIdx % 50 === 0) {
      const dt = (Date.now() - t0) / 1000;
      console.error(
        `  frame ${frameIdx}  ${(frameIdx / dt).toFixed(1)} fps enc  ` +
        `raw=${totalRaw} mv=${totalMv} skip=${totalSkip} msgs=${totalMsgs}`,
      );
    }
  }
});

ff.on("close", (code) => {
  if (code !== 0) { console.error(`[transcode] ffmpeg exited ${code}`); process.exit(1); }
  const durationMs = Math.round((frameIdx * 1000) / fps);
  const hdr = writer.close(durationMs);
  const sizeMB = fs.statSync(ccvPath).size / 1048576;
  const secs = (Date.now() - t0) / 1000;
  console.error(
    `[transcode] done: ${frameIdx} video frames -> ${hdr.msgCount} messages, ` +
    `${sizeMB.toFixed(1)} MB, ${secs.toFixed(1)}s\n` +
    `  avg raw px/frame=${(totalRaw / Math.max(frameIdx, 1)).toFixed(0)} ` +
    `mv/frame=${(totalMv / Math.max(frameIdx, 1)).toFixed(0)} ` +
    `skip/frame=${(totalSkip / Math.max(frameIdx, 1)).toFixed(0)}\n` +
    `  avg bitrate=${((totalBytes * 8) / (durationMs / 1000) / 1e6).toFixed(2)} Mbps`,
  );

  if (mismatch > 0) {
    console.error(`[transcode] FATAL: encoder/decoder divergence on ${mismatch} frames`);
    process.exit(2);
  }
  console.error(`[transcode] bit-exactness OK (encoder model == reference decoder)`);

  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({
    title: path.basename(outDir),
    durationMs,
    fps,
    width: W,
    height: H,
    block: BLOCK,
    dither: DITHER,
    ditherStrength: DITHER === "none" ? 0 : DITHER_STRENGTH,
    messages: hdr.msgCount,
    bytes: fs.statSync(ccvPath).size,
  }, null, 2));
});
