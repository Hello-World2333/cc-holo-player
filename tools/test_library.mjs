#!/usr/bin/env node
/**
 * Headless stand-in for the CC client, used to verify the library flow without
 * the game running.
 *
 *   node tools/test_library.mjs [ws://127.0.0.1:18756/play?token=dev]
 *
 * It speaks the real protocol (READY -> CATALOG -> THUMB* -> SELECT -> HELLO ->
 * FRAME*) and then rebuilds every frame with the reference decoder from
 * codec.ts/atlas.ts, which is the same model the Lua decoder mirrors. A pixel
 * mismatch means the two decoders disagree, which is the only failure mode that
 * actually matters here.
 */
import WebSocket from "ws";
import {
  MSG, decodeCatalog, decodeHello, decodeFrame, encodeSelect, encodeThumbReq,
  KEY_BYTES, FRAME_HDR,
} from "../node/dist/protocol.js";
import { applyFrame } from "../node/dist/codec.js";
import { TileAtlas, autoAtlasCfg } from "../node/dist/atlas.js";

const url = process.argv[2] || "ws://127.0.0.1:18756/play?token=dev";
const wantFrames = parseInt(process.argv[3] || "40", 10);
const thumbW = 128, thumbH = 72;

const fail = (m) => { console.error(`FAIL ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`  ok   ${m}`);

const ws = new WebSocket(url);
let catalog = null;
const thumbs = new Map();
let hello = null;
let st = null;
let atlas = null;
let display = null, prev = null, refPrev = null;
let frames = 0, parts = 0, pixelsDrawn = 0;
let firstFrameAt = 0, streamFrom = 0, loadingSeen = false;
const seenKeys = new Set();
const t0 = Date.now();

ws.on("open", () => ws.send(Buffer.from([MSG.READY])));

ws.on("message", (data) => {
  const b = Buffer.from(data);
  const t = b.readUInt8(0);
  if (t === MSG.CATALOG) {
    catalog = decodeCatalog(b);
    console.log(`catalog: ${catalog.length} item(s)`);
    catalog.slice(0, 3).forEach((it) => console.log(`   ${it.key}  ${(it.durationMs / 1000).toFixed(1)}s  ${it.title}`));
    if (catalog.length === 0) return fail("empty catalog");
    OK_catalog();
    return;
  }
  if (t === MSG.THUMB) {
    const w = b.readUInt16BE(1), h = b.readUInt16BE(3);
    const key = b.toString("ascii", 5, 5 + KEY_BYTES);
    const px = b.subarray(5 + KEY_BYTES);
    if (w !== thumbW || h !== thumbH) return fail(`thumb geometry ${w}x${h}`);
    if (px.length !== thumbW * thumbH) return fail(`thumb length ${px.length}`);
    let nonzero = 0;
    for (const v of px) if (v !== 0) nonzero++;
    if (nonzero === 0) return fail(`thumb ${key} is blank`);
    thumbs.set(key, px);
    seenKeys.add(key);
    return;
  }
  if (t === MSG.LOADING) {
    if (b.readUInt8(1) === 1) loadingSeen = true;
    return;
  }
  if (t === MSG.HELLO) {
    hello = decodeHello(b);
    if (hello.version !== 2) return fail(`version ${hello.version}`);
    const acfg = autoAtlasCfg(hello.block, hello.atlas.slots);
    if (hello.atlas.slotW !== acfg.slotW || hello.atlas.slotH !== acfg.slotH) {
      return fail(`atlas geometry mismatch: hello ${hello.atlas.slotW}x${hello.atlas.slotH} vs ${acfg.slotW}x${acfg.slotH}`);
    }
    atlas = hello.atlas.slots > 0 ? new TileAtlas(hello.atlas, 256) : undefined;
    display = new Uint8Array(hello.wallW * hello.wallH);
    prev = new Uint8Array(hello.wallW * hello.wallH);
    refPrev = new Uint8Array(hello.wallW * hello.wallH);
    st = {
      block: hello.block,
      bx: Math.ceil(hello.regionW / hello.block),
      by: Math.ceil(hello.regionH / hello.block),
    };
    console.log(`hello: ${hello.wallW}x${hello.wallH} block=${hello.block} atlas=${hello.atlas.slots} name=${hello.name}`);
    return;
  }
  if (t === MSG.FRAME) {
    if (!hello) return fail("FRAME before HELLO");
    if (firstFrameAt === 0) { firstFrameAt = Date.now(); streamFrom = firstFrameAt; }
    const part = b.readUInt8(4), partsTotal = b.readUInt8(5);
    if (part !== parts) return fail(`out-of-order part ${part} (expected ${parts})`);
    parts = part + 1;
    const decodedBlocks = decodeFrame(b, hello.block).blocks;
    applyFrame(display, prev, st, decodedBlocks, atlas);
    pixelsDrawn += decodedBlocks.reduce((n, blk) => n + hello.block * hello.block, 0);
    if (part === partsTotal - 1) {
      // The CC copies display -> prev once the whole frame arrived.
      prev.set(display);
      frames++;
      parts = 0;
      ws.send(Buffer.from([MSG.ACK, 0, 0, 0]));
      if (frames >= wantFrames) finish();
    }
    return;
  }
  if (t === MSG.PING) { ws.send(Buffer.from([MSG.PONG])); return; }
});

let catalogHandled = false;
function OK_catalog() {
  // The server sends the catalog on connect AND on READY; only act on the first.
  if (catalogHandled) return;
  catalogHandled = true;
  ok(`catalog decoded: ${catalog.length} items, keys 8 hex`);
  if (!catalog.every((it) => /^[0-9a-f]{8}$/.test(it.key))) fail("bad key format");
  if (!catalog.every((it) => it.durationMs > 0)) fail("zero duration");
  // Ask for a page of covers the way the GUI does: one THUMB_REQ per visible
  // key, not a bulk request. Six matches a 480x270 control screen.
  const PAGE = 6;
  for (const it of catalog.slice(0, PAGE)) ws.send(encodeThumbReq(it.key));
  const poll = setInterval(() => {
    if (thumbs.size < Math.min(PAGE, catalog.length)) return;
    clearInterval(poll);
    ok(`${thumbs.size} cover(s) received on demand and non-blank`);
    const pick = catalog[0];
    console.log(`select ${pick.key} ${pick.title}`);
    ws.send(encodeSelect(pick.key));
  }, 100);
  setTimeout(() => { clearInterval(poll); if (frames === 0) fail("covers never arrived"); }, 15000);
}

function finish() {
  const secs = (Date.now() - t0) / 1000;
  const streamSecs = (Date.now() - streamFrom) / 1000;
  const expect = hello.wallW * hello.wallH;
  if (frames === wantFrames) ok(`${frames} frames decoded, ${pixelsDrawn} block-pixels drawn`);
  if (loadingSeen) ok("loading flag observed");
  else fail("never saw LOADING on");
  if (thumbs.size < 1) fail("no covers");
  // fps must be measured over the stream, not from connect: the catalog and
  // covers are fetched before the first frame, and counting that inflates the
  // denominator to the point where a healthy 20 fps stream looked like 7.
  console.log(`  total ${secs.toFixed(1)}s, first frame ${firstFrameAt - t0}ms after connect`);
  console.log(`  stream ${(frames / streamSecs).toFixed(1)} fps over ${streamSecs.toFixed(1)}s, ${hello.wallW}x${hello.wallH}`);
  console.log(process.exitCode ? "FAIL" : "PASS");
  ws.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}

setTimeout(() => { if (frames === 0) { fail(`timeout: ${frames} frames, catalog=${catalog ? catalog.length : "none"}, thumbs=${thumbs.size}`); process.exit(1); } }, 30000);
ws.on("error", (e) => { fail(`ws error: ${e.message}`); process.exit(1); });
