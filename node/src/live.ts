/**
 * Streaming encoder: mp4 in, ccv messages out, while the video is playing.
 *
 * The offline path (transcode.ts) writes a .ccv file so a video can be verified
 * once and then streamed without touching the CPU. That does not scale to a
 * media library of 31 items: pre-encoding costs ~20-180s each and ~40 MB of disk
 * per item. This class produces the same messages from the source file with a
 * bounded lead, so picking a video starts playing in about a second.
 *
 * Three constraints shape the code below:
 *
 *  * `encodeFrame` mutates its `state` argument in place (it simulates what the
 *    decoder will actually show, tolerances included). So the caller holds ONE
 *    previous-frame buffer that is never reassigned, and only replaced wholesale
 *    on a key frame.
 *
 *  * The atlas and MV state are cumulative and sequential. There is no seeking:
 *    frame N only decodes correctly if frames 0..N-1 were encoded first. A seek
 *    would have to reset the atlas and force a key frame.
 *
 *  * ffmpeg delivers arbitrary chunk sizes, so a frame must be assembled from a
 *    partial buffer. A trailing partial frame at EOF is dropped, not zero-padded:
 *    padding would paint black bands over content that simply ended.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { TileAtlas, autoAtlasCfg, DEFAULT_BUCKET_CAP } from "./atlas.js";
import { encodeFrame, quantize, DitherMode, EncOptions, EncCfg, DEFAULT_OPTS } from "./codec.js";
import { frameParts, MAX_FRAME_BYTES, AtlasCfg } from "./protocol.js";

export interface LiveOpts {
  path: string;
  fps: number;
  width: number;
  height: number;
  block: number;
  dither: DitherMode;
  ditherStrength: number;
  atlasSlots: number;
  atlasScan?: number;
  enc?: Partial<EncOptions>;
}

/** One ready-to-send websocket message plus the pacing metadata the sender needs. */
export interface LiveMsg {
  msg: Buffer;
  timeMs: number;
  /** last ws part of this frame; the point where the client's ack frees credit */
  last: boolean;
}

export interface LiveStats {
  frames: number;
  messages: number;
  bytes: number;
  /** wall-clock ms spent inside quantize+encodeFrame, excluding ffmpeg waits */
  encodeMs: number;
  /** how far ahead of the presentation clock the encoder has run, in frames */
  leadFrames: number;
}

export class LiveEncoder {
  readonly cfg: EncCfg;
  readonly atlasCfg: AtlasCfg;
  readonly stats: LiveStats = { frames: 0, messages: 0, bytes: 0, encodeMs: 0, leadFrames: 0 };

  private ff?: ChildProcess;
  private atlas?: TileAtlas;
  private opts: EncOptions;
  private frameBytes: number;
  private buf: Buffer = Buffer.alloc(0);
  private prev: Uint8Array;
  private seq = 0;
  private frameIdx = 0;
  private pending: LiveMsg[] = [];
  private waiters: (() => void)[] = [];
  private ffDone = false;
  private ffCode: number | null = null;
  private ffError: string | null = null;
  private stopped = false;
  private stderrTail = "";

  constructor(private o: LiveOpts) {
    this.cfg = { w: o.width, h: o.height, block: o.block };
    this.atlasCfg = o.atlasSlots > 0
      ? autoAtlasCfg(o.block, o.atlasSlots)
      : { tile: 0, slotW: 0, slotH: 0, slots: 0 };
    this.atlas = o.atlasSlots > 0
      ? new TileAtlas(this.atlasCfg, o.atlasScan ?? DEFAULT_BUCKET_CAP)
      : undefined;
    this.opts = { ...DEFAULT_OPTS, ...o.enc };
    this.frameBytes = o.width * o.height * 3;
    this.prev = new Uint8Array(o.width * o.height);
  }

  start(): void {
    const { width: W, height: H, fps } = this.o;
    const ff = spawn("ffmpeg", [
      "-v", "error",
      "-i", this.o.path,
      "-vf", `scale=${W}:${H}:flags=area`,
      "-r", String(fps),
      "-f", "rawvideo", "-pix_fmt", "rgb24",
      "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    this.ff = ff;

    ff.stdout.on("data", (chunk: Buffer) => {
      // concat is O(n) per chunk; the buffer never exceeds one frame plus one
      // chunk, so this stays cheap even though it looks quadratic.
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.wake();
    });
    ff.stderr.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-500);
    });
    ff.on("error", (e) => {
      this.ffError = (e as Error).message;
      this.stderrTail = (this.stderrTail + String(e)).slice(-500);
      this.ffDone = true;
      this.wake();
    });
    ff.on("close", (code) => {
      this.ffDone = true;
      this.ffCode = code;
      this.wake();
    });
  }

  /** Human-readable reason the stream ended badly, if it did. */
  failure(): string | null {
    // A spawn error (ffmpeg not on PATH, bad path) fires "error" and never sets
    // ffCode, so reporting only on ffCode made a hard failure look like the
    // video simply ended.
    if (this.ffError) return `ffmpeg could not start: ${this.ffError}`;
    if (this.ffCode === 0 || this.ffCode === null) return null;
    return `ffmpeg exited ${this.ffCode}: ${this.stderrTail.trim().split("\n").slice(-2).join(" / ")}`;
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /**
   * Next message in playback order, or null at end of stream.
   *
   * Pull-based on purpose: the sender decides when it needs the next message, so
   * the encoder never races ahead of a slow client and never builds a queue of
   * thousands of frames. It also means the expensive work happens inside the
   * caller's tick, which is why serve.ts asks for one message at a time.
   */
  async next(): Promise<LiveMsg | null> {
    if (this.stopped) return null;
    while (this.pending.length === 0) {
      if (this.buf.length >= this.frameBytes) {
        this.encodeOne();
        continue;
      }
      if (this.ffDone) return null;
      await new Promise<void>((r) => this.waiters.push(r));
      if (this.stopped) return null;
    }
    const m = this.pending.shift()!;
    this.stats.leadFrames = Math.max(0, this.frameIdx - Math.round(m.timeMs / 1000 * this.o.fps));
    return m;
  }

  private encodeOne(): void {
    const W = this.o.width, H = this.o.height;
    const raw = this.buf.subarray(0, this.frameBytes);
    this.buf = this.buf.subarray(this.frameBytes);

    const t0 = process.hrtime.bigint();
    const cur = quantize(raw, W, H, { dither: this.o.dither, strength: this.o.ditherStrength });
    if (this.frameIdx === 0) {
      // No previous frame: force every block to RAW. Without this the first
      // MV/SKIP would copy from an uninitialised buffer.
      this.prev = new Uint8Array(W * H);
    }
    const frames = encodeFrame(cur, this.prev, this.cfg, this.seq, this.opts, this.atlas, this.frameIdx);
    const timeMs = Math.round((this.frameIdx * 1000) / this.o.fps);

    for (const f of frames) {
      const parts = frameParts(f.seq, f.flags, Math.ceil(W / this.o.block), Math.ceil(H / this.o.block), f.blocks, MAX_FRAME_BYTES);
      for (let i = 0; i < parts.length; i++) {
        this.pending.push({ msg: parts[i], timeMs, last: i === parts.length - 1 });
        this.stats.messages++;
        this.stats.bytes += parts[i].length;
      }
    }
    this.stats.frames = ++this.frameIdx;
    this.stats.encodeMs += Number(process.hrtime.bigint() - t0) / 1e6;
    this.seq += frames.length;
  }

  stop(): void {
    this.stopped = true;
    if (this.ff && !this.ffDone) {
      this.ff.kill("SIGKILL");
    }
    this.ffDone = true;
    this.wake();
  }
}
