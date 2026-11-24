#!/usr/bin/env node
/**
 * ccv stream server.
 *
 *   node dist/serve.js --library /path/to/mp4s --port 18755
 *   node dist/serve.js --dir videos --port 18755 [--video movie] [--loop 1]
 *
 * Two modes:
 *
 *  * **library** (when --library is given): the client receives a catalog of the
 *    directory plus a cover image per item, picks one, and the server encodes it
 *    on the fly. Nothing is pre-rendered, so dropping a file in the directory is
 *    enough — no transcode step, no per-item disk cost.
 *  * **file**: stream a pre-rendered .ccv (see transcode.ts). Kept because a
 *    verified file costs no CPU at all and is the safe option for a long film on
 *    a loaded machine.
 *
 * WS /play?token=X[&video=name]  -> HELLO then framed ccv messages, ACK-gated.
 * GET /health, GET /list
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { readCcvHeader, readCcvRecords, readCcvMessage, CcvHeader, CcvRecord } from "./container.js";
import {
  encodeHello, decodeAck, encodePing, encodeCatalog, encodeThumb, encodeLoading,
  audioParts, encodeAudioStart, encodeAudioDone, encodeAudioOpen, encodeAudioChunk,
  AUDIO_CHUNK_BYTES,
  MSG, VERSION, KEY_BYTES,
} from "./protocol.js";
import { getAudioTrack, AudioTrack, AudioOpts, DEFAULT_AUDIO_OPTS } from "./audio.js";
import { Library, LibItem } from "./library.js";
import { getThumbnail, THUMB_W, THUMB_H } from "./thumbs.js";
import { LiveEncoder } from "./live.js";
import { DitherMode, isDitherMode } from "./codec.js";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def === undefined) throw new Error(`missing --${name}`);
  return def;
}

function log(msg: string): void { console.error(`[serve] ${msg}`); }

const rootDir = arg("dir", "videos");
const libraryDir = arg("library", "");
const cacheDir = arg("cache", path.join(process.env.HOME ?? ".", ".cache", "cc-holo-player"));
const port = parseInt(arg("port", "18755"), 10);
const host = arg("host", "0.0.0.0");
const defaultVideo = arg("video", "");
const doLoop = arg("loop", "1") === "1";
const CREDIT = parseInt(arg("credit", "3"), 10);
const FPS = parseInt(arg("fps", "20"), 10);
const W = parseInt(arg("w", "640"), 10);
const H = parseInt(arg("h", "360"), 10);
const BLOCK = parseInt(arg("block", "8"), 10);
const ATLAS_SLOTS = parseInt(arg("atlas-slots", "14"), 10);
const ditherArg = arg("dither", "bayer8");
if (!isDitherMode(ditherArg)) { log(`bad --dither ${ditherArg}`); process.exit(1); }
const DITHER: DitherMode = ditherArg;
const DITHER_STRENGTH = parseFloat(arg("dither-strength", "1"));
/**
 * Audio. `--audio 0` disables the whole HQ path, which is the escape hatch if a
 * speaker run starts misbehaving: video must never be held hostage by sound.
 */
const AUDIO_ON = arg("audio", "1") === "1";
const AUDIO_OPTS: AudioOpts = {
  ...DEFAULT_AUDIO_OPTS,
  padSec: parseFloat(arg("audio-pad", String(DEFAULT_AUDIO_OPTS.padSec))),
  quality: parseFloat(arg("audio-quality", String(DEFAULT_AUDIO_OPTS.quality))),
  sampleRate: parseInt(arg("audio-rate", String(DEFAULT_AUDIO_OPTS.sampleRate)), 10),
};
const AUDIO_VOLUME = parseFloat(arg("audio-volume", "1"));
/**
 * How long to wait for the client to finish buffering a track before giving up
 * and starting the video anyway. 1.5 MB over a loopback websocket plus 48
 * speakAppend calls takes well under a second; five is generous.
 */
const AUDIO_READY_TIMEOUT_MS = parseInt(arg("audio-ready-ms", "5000"), 10);

if (libraryDir && (W % BLOCK !== 0 || H % BLOCK !== 0)) {
  log(`FATAL: block ${BLOCK} must divide ${W}x${H}`);
  process.exit(1);
}

// ---------- file mode ----------
interface Loaded { header: CcvHeader; recs: CcvRecord[]; fd: number; }

const fileCache = new Map<string, Loaded>();

function loadFile(name: string): Loaded {
  const hit = fileCache.get(name);
  if (hit) return hit;
  const fd = fs.openSync(path.join(rootDir, name, "video.ccv"), "r");
  const header = readCcvHeader(fd);
  const recs = readCcvRecords(fd, header);
  const l = { header, recs, fd };
  fileCache.set(name, l);
  return l;
}

function listVideos(): string[] {
  try {
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(rootDir, d.name, "video.ccv")))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ---------- library mode ----------
const library = libraryDir ? new Library(libraryDir, cacheDir, log) : null;
let items: LibItem[] = [];
/** key -> item, rebuilt on every rescan so a select never has to search. */
let byKey = new Map<string, LibItem>();

async function rescan(): Promise<void> {
  if (!library) return;
  items = await library.scan();
  byKey = new Map(items.map((it) => [it.key, it]));
}

const catalogMsg = (): Buffer => encodeCatalog(
  items.map((it) => ({ key: it.key, title: it.title, durationMs: it.durationMs })),
);

/**
 * Slot geometry for every library video. Derived once from a throwaway encoder so
 * this file and live.ts cannot drift apart, and so the client allocates exactly
 * the slots the first frame will reference.
 */
let atlasProbe: { tile: number; slotW: number; slotH: number; slots: number } | null = null;
function libraryAtlas() {
  if (!atlasProbe) {
    atlasProbe = new LiveEncoder({
      path: "/dev/null", fps: FPS, width: W, height: H, block: BLOCK,
      dither: DITHER, ditherStrength: DITHER_STRENGTH, atlasSlots: ATLAS_SLOTS,
    }).atlasCfg;
  }
  return atlasProbe;
}

function libraryHello(name: string): Buffer {
  return encodeHello({
    version: VERSION,
    block: BLOCK,
    fps: FPS,
    wallW: W, wallH: H,
    regionX: 0, regionY: 0, regionW: W, regionH: H,
    flags: 0,
    name: name.slice(0, 255),
    atlas: libraryAtlas(),
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  if (u.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      clients: wss.clients.size,
      mode: libraryDir ? "library" : "file",
      videos: libraryDir ? items.map((it) => it.title) : listVideos(),
      uptime: process.uptime(),
    }));
    return;
  }
  if (u.pathname === "/list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      videos: libraryDir ? items.map((it) => ({ key: it.key, title: it.title })) : listVideos(),
    }));
    return;
  }
  res.writeHead(404); res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/play" });

/**
 * Per-connection hooks that must react to a library change. A rescan can
 * invalidate queued covers (the file may be gone), so every connection gets its
 * queue cleared rather than left to fail one thumbnail at a time.
 */
const onLibraryChange = new Set<() => void>();

/** A message ready to ship, with the pacing metadata the sender needs. */
interface Out { msg: Buffer; timeMs: number; last: boolean; }

wss.on("connection", (ws, req) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  const queryVideo = u.searchParams.get("video") || defaultVideo;

  // Credit is counted in FRAMES, not messages: a frame may span several ws parts
  // but the client acks it once, so counting messages would deadlock.
  let inFlight = 0;
  // Streaming only starts once the client says it finished setting up its
  // hologram. Without this gate the first 49 KB frame arrives while the CC is
  // still inside resize()/allocateFrameBuffer() and is lost — the player then
  // starts mid-frame and every frame after it is corrupt.
  let clientReady = false;
  let idx = 0;
  let startAt = 0;
  let lastTimeMs = 0;
  let loopCount = 0;

  let live: LiveEncoder | null = null;
  let liveLabel = "";

  /**
   * Audio handshake state.
   *
   * `audioWait` is resolved by the client's AUDIO_READY (or by a timeout). It is
   * a promise rather than a flag so that the SELECT handler can await it without
   * blocking the socket's message loop — frames for the *previous* track may
   * still be draining while the next track is staged.
   */
  let audioWait: { resolve: (ok: boolean) => void } | null = null;
  let audioGeneration = 0;
  /** Set once the staged track has been told to play, so it only happens once. */
  let audioStarted = false;
  /** Audio staged for the current track; null when there is none to start. */
  let audioPending = false;
  /**
   * Bumped on every SELECT. A `pump()` that was awaiting the previous encoder
   * resolves with null once that encoder is stopped, and without this counter it
   * would take the null going out of the OLD stream as "the new stream ended"
   * and stop the encoder that replaced it. Selecting twice in a row hit exactly
   * that: the second selection played nothing.
   */
  let streamGen = 0;
  /** consumed-ahead message, held until its presentation time arrives */
  let pending: Out | null = null;
  let loadingSent = false;
  let tickBusy = false;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const open = (): boolean => ws.readyState === WebSocket.OPEN;

  const resetPacing = (): void => {
    idx = 0; startAt = 0; lastTimeMs = 0; inFlight = 0; pending = null;
  };

  const stopLive = (): void => {
    if (live) { live.stop(); live = null; }
    liveLabel = "";
    resetPacing();
  };

  // ---------- source: file mode ----------
  let file: Loaded | null = null;
  let fileIdxWanted = 0;

  const fileNext = (v: Loaded): Out | null => {
    if (fileIdxWanted >= v.recs.length) {
      if (!doLoop) return null;
      fileIdxWanted = 0;
      loopCount++;
      log(`loop ${loopCount}`);
    }
    const r = v.recs[fileIdxWanted++];
    return {
      msg: readCcvMessage(v.fd, r),
      timeMs: r.timeMs,
      last: r.part === r.parts - 1,
    };
  };

  // ---------- source: library mode ----------
  const liveNext = async (enc: LiveEncoder): Promise<Out | null> => {
    const m = await enc.next();
    if (!m) return null;
    return { msg: m.msg, timeMs: m.timeMs, last: m.last };
  };

  /**
   * Send whatever is due, up to the credit limit.
   *
   * The `pending` slot exists because the presentation clock must be checked
   * *after* a message is produced but *before* it is sent: the encoder has no
   * idea how far ahead the wall clock is, so consuming greedily would burst the
   * whole video. Holding one message back also means a slow client simply stops
   * being fed instead of queueing up thousands of frames.
   */
  const pump = async (): Promise<void> => {
    while (open() && clientReady && inFlight < CREDIT) {
      if (!pending) {
        if (file) {
          pending = fileNext(file);
          if (!pending) { if (!doLoop) log(`finished ${queryVideo || defaultVideo}`); return; }
        } else if (live) {
          const myGen = streamGen;
          const enc = live;
          const got = await liveNext(enc);
          if (myGen !== streamGen) return;   // superseded by a newer SELECT
          if (!got) {
            const why = enc.failure();
            // A clean null with no failure means ffmpeg reached end of file, i.e.
            // the video simply finished. Stopping there is what froze the wall:
            // the client keeps the last frame, gets no more messages, and after
            // STALL_MS its watchdog reconnects as if the link had died.
            if (why) {
              log(`stream failed (${liveLabel}): ${why}`);
              stopLive();
              return;
            }
            if (doLoop && liveItem) {
              loopCount++;
              log(`loop ${loopCount} ${liveLabel}`);
              // Restage the audio too: the client's speaker session was consumed
              // by the pass that just ended, so replaying the video without a new
              // AUDIO_OPEN would loop the picture silently.
              const again = liveItem;
              void beginTrack(again).catch((e) => log(`loop failed: ${(e as Error).message}`));
              return;
            }
            log(`finished ${liveLabel}`);
            stopLive();
            return;
          }
          pending = got;
        } else {
          return;
        }
      }
      if (startAt === 0) startAt = Date.now() - pending.timeMs;
      if (Date.now() - startAt < pending.timeMs) return;

      const m = pending;
      pending = null;
      if (!open()) return;
      // Start the staged audio on the tick the first frame leaves for the client.
      // The track is already buffered inside the speaker session, so this call
      // does not block; the picture and the sound therefore begin together
      // instead of the sound leading by the encoder's first-frame latency.
      if (audioPending && !audioStarted) {
        audioStarted = true;
        audioPending = false;
        ws.send(encodeAudioStart(), { binary: true });
        log("audio: start sent with first frame");
      }
      if (!loadingSent) { loadingSent = true; ws.send(encodeLoading(false)); }
      ws.send(m.msg, { binary: true });
      idx++;
      if (m.last) { inFlight++; lastTimeMs = m.timeMs; }
      if (idx % 500 === 0 && !libraryDir) log(`sent ${idx}`);
    }
  };

  const tick = (): void => {
    if (tickBusy) return;
    tickBusy = true;
    void pump().catch((e) => log(`pump failed: ${(e as Error).message}`))
      .finally(() => { tickBusy = false; });
  };

  // ---------- covers ----------
  /**
   * Covers are produced on demand from THUMB_REQ, two at a time. The client asks
   * for one page (six keys) when it draws the grid, so the queue never holds more
   * than a page and a slow ffmpeg cannot build a backlog.
   */
  let thumbQueue: LibItem[] = [];
  let thumbsRunning = 0;
  const THUMB_CONCURRENCY = 2;

  const pumpThumbs = (): void => {
    while (thumbsRunning < THUMB_CONCURRENCY && thumbQueue.length > 0) {
      const item = thumbQueue.shift()!;
      thumbsRunning++;
      void getThumbnail(item, cacheDir)
        .then((px) => { if (open()) ws.send(encodeThumb(item.key, THUMB_W, THUMB_H, px), { binary: true }); })
        .catch((e) => log(`thumbnail ${item.title} failed: ${(e as Error).message}`))
        .finally(() => { thumbsRunning--; pumpThumbs(); });
    }
  };

  /** Which library item is playing, so a finished stream can be restarted. */
  let liveItem: LibItem | null = null;

  /**
   * Start (or restart) the stream for `item`.
   *
   * A restart after end-of-file is a full reset, not a seek: the atlas, the MV
   * reference frame and the sequence number all have to go back to frame 0, and
   * the client has to forget its buffers. That is why looping goes through here
   * and re-sends HELLO instead of rewinding the existing encoder.
   */
  /**
   * Send the whole ogg track and wait for the client to buffer it.
   *
   * Returns true when the client confirmed it is staged. Any failure — no audio
   * stream, no speakers, a slow client — returns false, and the caller starts the
   * video regardless: the wall is a video player first.
   */
  const stageAudio = async (item: LibItem, myGen: number): Promise<boolean> => {
    if (!AUDIO_ON) return false;
    audioPending = false;
    audioStarted = false;
    let track: AudioTrack;
    const t0 = Date.now();
    try {
      track = await getAudioTrack(
        { path: item.path, durationMs: item.durationMs },
        cacheDir,
        AUDIO_OPTS,
        log,
      );
    } catch (e) {
      log(`audio: preparation failed: ${(e as Error).message}`);
      return false;
    }
    if (myGen !== streamGen || !open()) return false;
    log(`audio: ${(track.data.length / 1024).toFixed(0)} KiB, ${track.seconds.toFixed(1)} s` +
        `${track.cacheHit ? " (cached)" : ` in ${Date.now() - t0}ms`}`);

    const waited = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        log("audio: client did not acknowledge the track, starting video anyway");
        audioWait = null;
        resolve(false);
      }, AUDIO_READY_TIMEOUT_MS);
      audioWait = {
        resolve: (ok) => { clearTimeout(timer); audioWait = null; resolve(ok); },
      };
    });

    for (const part of audioParts(track.data, AUDIO_CHUNK_BYTES)) {
      if (!open() || myGen !== streamGen) return false;
      ws.send(part, { binary: true });
    }
    const ok = await waited;
    if (ok && myGen === streamGen) {
      audioPending = true;
      log(`audio: staged on client in ${Date.now() - t0}ms`);
    }
    return ok;
  };

  const startLive = (item: LibItem): void => {
    streamGen++;
    stopLive();
    liveItem = item;
    liveLabel = item.title;
    const enc = new LiveEncoder({
      path: item.path,
      fps: FPS, width: W, height: H, block: BLOCK,
      dither: DITHER, ditherStrength: DITHER_STRENGTH, atlasSlots: ATLAS_SLOTS,
    });
    live = enc;
    enc.start();
    // A fresh HELLO is the "new stream" signal: same geometry for every library
    // item, so the client reuses its framebuffers and only clears them. Sending
    // it before the first frame is what lets the client drop the previous video's
    // atlas contents without reallocating 15 framebuffers.
    ws.send(libraryHello(item.key));
    ws.send(encodeLoading(true));
    loadingSent = false;
    resetPacing();
  };

  /**
   * Begin a track: stop whatever is playing, stage its audio, then start the
   * encoder. Shared by SELECT and by the end-of-file loop so that a looping
   * video gets its audio restaged instead of playing the previous pass's track.
   */
  const beginTrack = async (item: LibItem): Promise<void> => {
    // Bump the generation BEFORE staging so that frames from the outgoing track
    // stop going out immediately: the client is about to spend time appending
    // audio and must not have a stale video running underneath it.
    streamGen++;
    const myGen = streamGen;
    stopLive();
    liveLabel = "";
    ws.send(encodeLoading(true));
    const staged = await stageAudio(item, myGen);
    if (myGen !== streamGen || !open()) return;
    startLive(item);
    // A false here is normal when the item has no audio; stageAudio logs why.
    if (!staged) log("audio: none for this track");
    void tick();
  };

  const clearThumbs = (): void => { thumbQueue = []; };
  onLibraryChange.add(clearThumbs);

  ws.on("close", () => {
    // Release any await inside stageAudio; otherwise it sits until the timeout
    // and keeps a listener alive on a dead socket.
    if (audioWait) audioWait.resolve(false);
    onLibraryChange.delete(clearThumbs);
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    stopLive();
    log(`client disconnected (loops=${loopCount}, sent=${idx} msgs)`);
  });

  ws.on("message", (data: Buffer) => {
    if (data.length === 0) return;
    switch (data.readUInt8(0)) {
      case MSG.ACK: {
        const a = decodeAck(data);
        inFlight = Math.max(0, inFlight - 1);
        if (a.status !== 0) log(`ack status=${a.status} seq=${a.seq} decode=${a.decodeMs}ms`);
        break;
      }
      case MSG.READY:
        if (!clientReady) {
          clientReady = true;
          log("client READY");
        }
        break;
      case MSG.CATALOG_REQ:
        if (libraryDir) ws.send(catalogMsg());
        break;
      case MSG.THUMB_REQ: {
        if (!libraryDir) break;
        const key = data.toString("ascii", 1, 1 + KEY_BYTES);
        const it = byKey.get(key);
        if (it && !thumbQueue.some((q) => q.key === key)) { thumbQueue.unshift(it); pumpThumbs(); }
        break;
      }
      case MSG.SELECT: {
        if (!libraryDir) break;
        const key = data.toString("ascii", 1, 1 + KEY_BYTES);
        const it = byKey.get(key);
        if (!it) { log(`select failed: unknown key ${key}`); break; }
        log(`select ${it.title} (${it.key})`);
        void beginTrack(it).catch((e) => log(`select failed: ${(e as Error).message}`));
        break;
      }
      case MSG.AUDIO_READY: {
        // u8 status: 0 ok, else the client has no usable audio path. Either way
        // the wait ends and the video starts; a broken speaker run must not be
        // able to stop the wall.
        const st = data.readUInt8(1);
        if (audioWait) {
          if (st !== 0) log(`audio: client reports status ${st}`);
          audioWait.resolve(st === 0);
        }
        break;
      }
      case MSG.PONG:
        break;
    }
  });

  setInterval(() => { if (open()) ws.send(encodePing()); }, 200);

  tickTimer = setInterval(tick, 4);

  // File mode keeps its old behaviour: start the named video on connect.
  if (!libraryDir) {
    const want = queryVideo || listVideos()[0];
    if (!want) { ws.close(1011, "no video"); return; }
    try { file = loadFile(want); } catch (e) {
      log(`cannot load ${want}: ${(e as Error).message}`);
      ws.close(1011, "no such video"); return;
    }
    log(`client connected, video=${want} (${file.recs.length} msgs, ${file.header.wallW}x${file.header.wallH})`);
    ws.send(encodeHello({
      version: VERSION,
      block: file.header.block,
      fps: file.header.fps,
      wallW: file.header.wallW, wallH: file.header.wallH,
      regionX: file.header.regionX, regionY: file.header.regionY,
      regionW: file.header.regionW, regionH: file.header.regionH,
      flags: 0,
      name: want,
      atlas: {
        tile: file.header.block,
        slotW: file.header.atlasSlotW,
        slotH: file.header.atlasSlotH,
        slots: file.header.atlasSlots,
      },
    }));
  } else {
    // The catalog goes out on connect, NOT after READY.
    //
    // READY exists to say "my framebuffers are allocated, start streaming", and
    // the client only sends it after a HELLO — but in library mode there is no
    // HELLO until the user picks something. Waiting for READY would deadlock:
    // no HELLO -> no READY -> no catalog -> the user has nothing to pick.
    // Only the catalog is pushed, and only here. It used to also be sent on
    // READY, which meant the client saw it twice and (in the test client) issued
    // two SELECTs for the same item — the second one restarting the stream that
    // the first had just started. One catalog per connection, plus CATALOG_REQ
    // for an explicit resend, is enough.
    //
    // Covers are never pushed: 31 of them is 286 KB dumped on a connection that
    // may already be streaming, and the client only shows six at a time. It asks
    // per key via THUMB_REQ instead.
    log("client connected (library mode), sending catalog");
    ws.send(catalogMsg());
  }
});

server.listen(port, host, () => {
  log(`listening on ${host}:${port}  mode=${libraryDir ? `library ${libraryDir}` : `file ${rootDir}`}`);
  if (!library) return;
  void rescan().then(() => {
    log(`library: ${items.length} item(s)`);
    library.watch(() => {
      void rescan().then(() => {
        log(`library changed: ${items.length} item(s)`);
        // Only the catalog is pushed. Covers are pulled by the client one page at
        // a time, so a hot reload of a 31-item library does not dump 288 KB of
        // images into a stream that is currently playing.
        for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(catalogMsg());
        for (const reset of onLibraryChange) reset();
      });
    });
  });
});
