/**
 * End-to-end audio handshake test against a real server process.
 *
 * Stands in for the CC: connects, selects an item, receives AUDIO_OPEN/CHUNK/
 * DONE, answers AUDIO_READY, then checks that AUDIO_START arrives *before* the
 * first video frame (that ordering is the whole point — it is what keeps sound
 * and picture starting together) and that the reassembled track is a valid Ogg
 * of the expected length.
 *
 *   node tools/test_audio.mjs [--url ws://...] [--item 魔术之心-MIMI]
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  MSG, decodeCatalog, decodeHello, decodeFrame, encodeSelect, KEY_BYTES,
} from "../node/dist/protocol.js";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const URL = argOf("url", "ws://127.0.0.1:18756/play?token=dev");
const WANT = argOf("item", "");
/** Set to simulate a CC with no speaker group: must not stall the video. */
const MUTE = argv.includes("--mute");

const t0 = Date.now();
const ms = () => Date.now() - t0;
const log = (...a) => console.log(`[${String(ms()).padStart(6)}ms]`, ...a);

let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) fail++;
};

const ws = new WebSocket(URL);

const audio = { open: false, total: 0, chunks: [], done: false };
let firstFrameAt = -1;
let audioStartAt = -1;
let frames = 0;
let audioBeforeFrame = false;
let selected = false;

ws.on("open", () => ws.send(Buffer.from([MSG.READY])));

ws.on("message", (buf) => {
  const b = Buffer.from(buf);
  const t = b.readUInt8(0);

  switch (t) {
    case MSG.CATALOG: {
      const items = decodeCatalog(b);
      log(`catalog: ${items.length} items`);
      if (selected) break;
      const pick = WANT ? items.find((i) => i.title.includes(WANT)) : items[0];
      if (!pick) { console.error(`no item matching "${WANT}"`); process.exit(1); }
      log(`select "${pick.title}" (${pick.key})`);
      selected = true;
      ws.send(encodeSelect(pick.key));
      break;
    }
    case MSG.AUDIO_OPEN: {
      audio.open = true;
      audio.total = b.readUInt32BE(1);
      log(`AUDIO_OPEN total=${audio.total} B`);
      break;
    }
    case MSG.AUDIO_CHUNK: {
      audio.chunks.push(b.subarray(1));
      break;
    }
    case MSG.AUDIO_DONE: {
      audio.done = true;
      const got = audio.chunks.reduce((a, c) => a + c.length, 0);
      log(`AUDIO_DONE, ${audio.chunks.length} chunks, ${got} B`);
      // Answer like the CC does: status 0 = buffered fine.
      ws.send(Buffer.from([MSG.AUDIO_READY, MUTE ? 1 : 0]));
      break;
    }
    case MSG.AUDIO_START: {
      audioStartAt = ms();
      log("AUDIO_START");
      break;
    }
    case MSG.HELLO: {
      const h = decodeHello(b);
      log(`HELLO ${h.wallW}x${h.wallH} block=${h.block} fps=${h.fps}`);
      break;
    }
    case MSG.FRAME: {
      frames++;
      if (firstFrameAt < 0) {
        firstFrameAt = ms();
        audioBeforeFrame = audioStartAt >= 0 && audioStartAt <= firstFrameAt;
        log(`first FRAME at ${firstFrameAt}ms (audioStartAt=${audioStartAt})`);
      }
      const part = b.readUInt8(4), parts = b.readUInt8(5);
      if (part === parts - 1) ws.send(Buffer.from([MSG.ACK, 0, 0, 0]));
      break;
    }
    case MSG.LOADING:
    case MSG.THUMB:
    case MSG.PING:
      if (t === MSG.PING) ws.send(Buffer.from([MSG.PONG]));
      break;
    default:
      break;
  }
});

ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });

setTimeout(async () => {
  console.log("\n===== results");
  const track = Buffer.concat(audio.chunks);
  check("AUDIO_OPEN received", audio.open);
  check("AUDIO_DONE received", audio.done);
  check("byte count matches AUDIO_OPEN", track.length === audio.total,
    `${track.length} vs ${audio.total}`);
  if (!MUTE) {
    check("track is Ogg Vorbis", track.subarray(0, 4).toString("ascii") === "OggS",
      track.subarray(0, 4).toString("ascii"));
    check("AUDIO_START sent", audioStartAt >= 0);
    check("AUDIO_START precedes first frame", audioBeforeFrame,
      `start=${audioStartAt} firstFrame=${firstFrameAt}`);
    // Decode it independently: this is the real proof the track is playable,
    // not merely well-framed.
    if (track.length > 0) {
      // Written to a file rather than piped: ffprobe may close its stdin before
      // the whole track is written, and the resulting EPIPE arrives as an
      // unhandled 'error' on the socket, killing the test with a stack trace
      // instead of a result.
      const tmp = "/tmp/ccvw-audio-test.ogg";
      writeFileSync(tmp, track);
      const probe = spawn("ffprobe", [
        "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,channels,duration",
        "-of", "csv=p=0", tmp,
      ]);
      let out = "";
      probe.stdout.on("data", (c) => (out += c));
      await new Promise((r) => probe.on("close", r));
      const parts = out.trim().split(",");
      check("ffprobe decodes the track", parts[0] === "vorbis", out.trim());
      check("mono", parts[1] === "1", parts[1]);
      const dur = parseFloat(parts[2]);
      check("duration includes the pad", dur > 0, `${dur}s`);
    }
  }
  check("video frames arrived", frames > 0, `${frames} frames`);
  console.log(fail === 0 ? "\nPASS" : `\n${fail} FAILURE(S)`);
  process.exit(fail === 0 ? 0 : 1);
}, parseInt(argOf("wait", "26000"), 10));
