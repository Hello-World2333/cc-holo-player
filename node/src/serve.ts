#!/usr/bin/env node
/**
 * ccv stream server.
 *   node dist/serve.js --dir videos --port 18755 [--video movie] [--loop 1]
 *
 * WS /play?token=X[&video=name]  -> HELLO then framed ccv messages, ACK-gated.
 * GET /health, GET /list
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { readCcvHeader, readCcvRecords, readCcvMessage, CcvHeader, CcvRecord } from "./container.js";
import { encodeHello, decodeAck, encodePing, MSG, VERSION } from "./protocol.js";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def === undefined) throw new Error(`missing --${name}`);
  return def;
}

const rootDir = arg("dir", "videos");
const port = parseInt(arg("port", "18755"), 10);
const host = arg("host", "0.0.0.0");
const defaultVideo = arg("video", "");
const doLoop = arg("loop", "1") === "1";
const CREDIT = parseInt(arg("credit", "3"), 10);

interface Loaded {
  header: CcvHeader;
  recs: CcvRecord[];
  fd: number;
}

const cache = new Map<string, Loaded>();

function load(name: string): Loaded {
  const hit = cache.get(name);
  if (hit) return hit;
  const ccv = path.join(rootDir, name, "video.ccv");
  const fd = fs.openSync(ccv, "r");
  const header = readCcvHeader(fd);
  const recs = readCcvRecords(fd, header);
  const l = { header, recs, fd };
  cache.set(name, l);
  return l;
}

function listVideos(): string[] {
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(rootDir, d.name, "video.ccv")))
    .map((d) => d.name);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  if (u.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients: wss.clients.size, videos: listVideos(), uptime: process.uptime() }));
    return;
  }
  if (u.pathname === "/list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ videos: listVideos() }));
    return;
  }
  res.writeHead(404); res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/play" });

wss.on("connection", (ws, req) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  const want = u.searchParams.get("video") || defaultVideo || listVideos()[0];
  if (!want) { ws.close(1011, "no video"); return; }
  let v: Loaded;
  try { v = load(want); } catch (e) {
    console.error(`[serve] cannot load ${want}: ${(e as Error).message}`);
    ws.close(1011, "no such video"); return;
  }
  console.error(`[serve] client connected, video=${want} (${v.recs.length} msgs, ${v.header.wallW}x${v.header.wallH})`);

  // Credit is counted in FRAMES, not messages: a frame may span several parts
  // but the client only acks it once, so counting messages would deadlock.
  let inFlight = 0;
  let ackedSeq = -1;
  // Streaming only starts once the client says it has finished setting up its
  // hologram. Without this gate the first 49 KB frame is sent while the CC is
  // still inside resize()/allocateFrameBuffer() and that message is lost — the
  // player then starts from frame 0 part 1 and every frame is corrupt.
  let clientReady = false;
  let idx = 0;
  let startAt = 0;
  let lastTimeMs = 0;
  let done = false;
  let loopCount = 0;

  ws.send(encodeHello({
    version: VERSION,
    block: v.header.block,
    fps: v.header.fps,
    wallW: v.header.wallW,
    wallH: v.header.wallH,
    regionX: v.header.regionX,
    regionY: v.header.regionY,
    regionW: v.header.regionW,
    regionH: v.header.regionH,
    flags: 0,
    name: want,
  }));

  const restart = () => {
    idx = 0; startAt = 0; lastTimeMs = 0; done = false; loopCount++;
    console.error(`[serve] loop ${loopCount} for ${want}`);
  };

  ws.on("message", (data: Buffer) => {
    const t = data.readUInt8(0);
    if (t === MSG.ACK) {
      const a = decodeAck(data);
      ackedSeq = a.seq;
      inFlight = Math.max(0, inFlight - 1);
      if (a.status !== 0) console.error(`[serve] ack status=${a.status} seq=${a.seq} decode=${a.decodeMs}ms`);
    } else if (t === MSG.PONG) {
      // keepalive
    } else if (t === MSG.READY) {
      if (!clientReady) {
        clientReady = true;
        console.error("[serve] client READY, starting stream");
      }
    }
  });

  ws.on("close", () => {
    console.error(`[serve] client disconnected (loops=${loopCount}, sent=${idx} msgs)`);
    clearInterval(tick);
    clearInterval(ping);
    clearTimeout(readyTimeout);
  });

  // Compatibility escape hatch: an older client (or one with a broken READY path)
  // would otherwise never receive anything. Start anyway, but late and noisily.
  const readyTimeout = setTimeout(() => {
    if (!clientReady && ws.readyState === WebSocket.OPEN) {
      console.error("[serve] WARNING: no READY after 3s, streaming anyway");
      clientReady = true;
    }
  }, 3000);

  let ticks = 0;
  const tick = setInterval(() => {
    if (process.env.DBG && ticks++ < 30) {
      console.error(`[dbg] tick idx=${idx} inFlight=${inFlight} ready=${ws.readyState === WebSocket.OPEN}`);
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!clientReady) return;
    if (inFlight >= CREDIT) return;
    if (idx >= v.recs.length) {
      if (doLoop) { if (inFlight === 0) restart(); }
      else if (!done) { done = true; }
      return;
    }
    const r = v.recs[idx];
    if (startAt === 0) startAt = Date.now() - r.timeMs;
    // don't run more than CREDIT frames ahead of the presentation clock
    if (r.timeMs > lastTimeMs && Date.now() - startAt < r.timeMs) return;

    try {
      const payload = readCcvMessage(v.fd, r);
      if (process.env.DBG && idx < 8) console.error(`[dbg] send idx=${idx} len=${payload.length} part=${r.part}/${r.parts}`);
      ws.send(payload, { binary: true });
    } catch (e) {
      console.error(`[serve] send failed: ${(e as Error).message}`);
      return;
    }
    idx++;
    if (r.part === r.parts - 1) {
      inFlight++;
      lastTimeMs = r.timeMs;
    }
    if (idx % 500 === 0) console.error(`[serve] sent ${idx}/${v.recs.length}`);
  }, 4);

  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodePing());
  }, 200);
});

server.listen(port, host, () => {
  console.error(`[serve] listening on ${host}:${port}  dir=${rootDir}  videos=[${listVideos().join(", ")}]`);
});
