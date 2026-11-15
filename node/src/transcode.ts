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
  DEFAULT_OPTS, encodeFrame, quantize, applyFrame, EncOptions,
} from "./codec.js";
import { VERSION, frameParts } from "./protocol.js";

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

console.error(`[transcode] ${inPath} -> ${ccvPath}  ${W}x${H} @${fps}fps block=${BLOCK}`);

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

    const cur = quantize(raw, W, H);
    const isFirst = frameIdx === 0;
    // force a key frame every `keyEvery` frames, if requested
    const forceKey = isFirst || (keyEvery > 0 && frameIdx % keyEvery === 0);
    if (forceKey) {
      prev = new Uint8Array(W * H); // "no previous frame": force RAW everywhere
      refDisplay = new Uint8Array(W * H);
      refPrev = new Uint8Array(W * H);
    }

    const frames = encodeFrame(cur, prev, { w: W, h: H, block: BLOCK }, seq, opts);
    const timeMs = Math.round((frameIdx * 1000) / fps);

    for (const f of frames) {
      // bit-exactness check: the reference decoder must land where the encoder expects
      applyFrame(refDisplay, refPrev, { w: W, h: H, block: BLOCK }, f.blocks);
      refPrev.set(refDisplay);
      const parts = frameParts(f.seq, f.flags, Math.ceil(W / BLOCK), Math.ceil(H / BLOCK), f.blocks, MAX_MSG);
      for (const p of parts) {
        const partIdx = p.readUInt8(4);
        const partTotal = p.readUInt8(5);
        writer.add(p, f.seq, partIdx, partTotal, timeMs);
        totalBytes += p.length;
        totalMsgs++;
      }
      totalRaw += f.rawPixels;
      totalMv += f.mvBlocks;
      totalSkip += f.skipBlocks;
      seq++;
    }

    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== refPrev[i]) { mismatch++; break; }
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
    messages: hdr.msgCount,
    bytes: fs.statSync(ccvPath).size,
  }, null, 2));
});
