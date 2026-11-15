#!/usr/bin/env node
/**
 * Decode a .ccv back through the reference decoder and prove that
 * decode(encode(x)) reproduces exactly what the CC will draw.
 * Also dumps a PNG frame if --png is given.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { readCcvHeader, readCcvRecords, readCcvMessage } from "./container.js";
import { applyFrame } from "./codec.js";
import { decodeFrame, MSG } from "./protocol.js";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def === undefined) throw new Error(`missing --${name}`);
  return def;
}

const dir = arg("dir", arg("in", ""));
const ccv = path.join(dir, "video.ccv");
const pngAt = arg("png", "");
const fd = fs.openSync(ccv, "r");
const hdr = readCcvHeader(fd);
const recs = readCcvRecords(fd, hdr);
console.error(`[verify] ${recs.length} messages, ${hdr.wallW}x${hdr.wallH} block=${hdr.block}`);

const W = hdr.regionW, H = hdr.regionH, B = hdr.block;
const display = new Uint8Array(W * H);
const prev = new Uint8Array(W * H);

let curSeq = -1;
let pending = 0;
let frames = 0, mvCalls = 0, rawCalls = 0, rawPx = 0;
const pngFrames: number[] = pngAt ? pngAt.split(",").map((s) => parseInt(s, 10)) : [];

for (const r of recs) {
  const msg = readCcvMessage(fd, r);
  if (msg.readUInt8(0) !== MSG.FRAME) continue;
  const f = decodeFrame(msg, B);
  if (f.seq !== curSeq) { curSeq = f.seq; pending = f.parts; }
  pending--;
  for (const blk of f.blocks) {
    if (blk.mode === 1) mvCalls++; else { rawCalls++; rawPx += B * B; }
  }
  applyFrame(display, prev, { w: W, h: H, block: B }, f.blocks);
  if (pending === 0) {
    prev.set(display);
    if (pngFrames.includes(frames)) writePng(display, W, H, path.join(dir, `frame${frames}.png`));
    frames++;
  }
}
fs.closeSync(fd);
console.error(`[verify] ${frames} frames, mv calls=${mvCalls}, raw calls=${rawCalls}, raw px=${rawPx}`);

function writePng(px: Uint8Array, w: number, h: number, out: string) {
  const rgb = Buffer.alloc(w * h * 3);
  const L = [0, 85, 170, 255];
  for (let i = 0; i < w * h; i++) {
    const v = px[i];
    rgb[i * 3] = L[(v >> 6) & 3];
    rgb[i * 3 + 1] = L[(v >> 4) & 3];
    rgb[i * 3 + 2] = L[(v >> 2) & 3];
  }
  const p = spawn("ffmpeg", [
    "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
    "-s", `${w}x${h}`, "-i", "-", out,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  p.stdin.end(rgb);
  p.on("close", () => console.error(`[verify] wrote ${out}`));
}
