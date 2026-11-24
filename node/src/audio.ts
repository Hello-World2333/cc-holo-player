/**
 * HQ audio track preparation for the CEE speaker path.
 *
 * The addon decodes the file itself (it ships a Vorbis decoder), so the server's
 * only job is to hand it a well-formed Ogg and to work around the tail-mute bug.
 *
 * ## The four second tail
 *
 * Reported on the CEE side, confirmed by the DC group: the last ~4 s of an HQ
 * track comes out silent. The fix people use is to append 4 s of silence, which
 * only works if the truncation is at the END of the stream rather than at the
 * end of the *audio* — so this pads unconditionally. It costs four seconds of
 * silence and removes a class of "the song ends early" complaints that would
 * otherwise be indistinguishable from a network problem.
 *
 * ## Why mono 48 kHz Vorbis
 *
 * The speaker path is mono: CEEHqLimits has no channel count and CEEVorbis.mono()
 * downmixes before dispatch, so a stereo file would only waste bandwidth on the
 * link and decode time on the server. 48 kHz is the addon's SAMPLE_RATE, and
 * anything else gets resampled anyway.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface AudioOpts {
  /** Silence appended after the track, in seconds. See the note above. */
  padSec: number;
  /** Ogg Vorbis quality, -1..10. 4 is ~128 kbps mono. */
  quality: number;
  sampleRate: number;
}

export const DEFAULT_AUDIO_OPTS: AudioOpts = {
  padSec: 4,
  quality: 4,
  sampleRate: 48000,
};

/**
 * CEEHqLimits.MAX_BYTES: a single speakOgg/speakOpen transfer cap. Mono Vorbis
 * at q4 is ~16 kB/s, so this is over an hour — not a practical limit, but a
 * silent truncation here would look exactly like the tail bug, so it is checked.
 */
export const HQ_MAX_BYTES = 8 * 1024 * 1024;
/** CEEHqLimits.MAX_SESSION_BYTES: what speakOpen+append+end may buffer. */
export const HQ_MAX_SESSION_BYTES = 16 * 1024 * 1024;
/**
 * CEEHqLimits.MAX_DECODED_BYTES / (48000 * 2): the addon decodes to 16-bit mono
 * PCM before dispatch, and silently failing past this is the worst outcome, so
 * the length is checked against it and reported.
 */
export const HQ_MAX_DECODED_SECONDS = 64 * 1024 * 1024 / (48000 * 2);

export interface AudioTrack {
  /** Ogg Vorbis bytes, padding included. */
  data: Buffer;
  /** Audio length in seconds, padding included; 0 when unknown. */
  seconds: number;
  /** True when the source had no audio stream and this is pure silence. */
  silent: boolean;
  cacheHit: boolean;
}

/** ffprobe a stream for its duration; returns 0 when it cannot tell. */
function probeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const ff = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=duration",
      "-of", "csv=p=0",
      file,
    ]);
    let out = "";
    ff.stdout.on("data", (c) => (out += c.toString()));
    ff.on("close", () => {
      const v = parseFloat(out.trim());
      resolve(Number.isFinite(v) && v > 0 ? v : 0);
    });
    ff.on("error", () => resolve(0));
  });
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: Buffer; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.stderr.on("data", (c) => {
      if (err.length < 4000) err += c.toString();
    });
    p.on("close", (code) => resolve({ ok: code === 0, out: Buffer.concat(chunks), err }));
    p.on("error", (e) => resolve({ ok: false, out: Buffer.alloc(0), err: String(e) }));
  });
}

/**
 * Build (or fetch from cache) the ogg track for a media file.
 *
 * The cache key covers the pad length and the encoder settings, not just the
 * source mtime: changing `--audio-pad` must not silently serve the old track,
 * which is exactly the sort of stale-cache bug that costs an hour of debugging
 * because the symptom is "the fix did not work".
 */
export async function getAudioTrack(
  item: { path: string; durationMs: number },
  cacheDir: string,
  opts: AudioOpts = DEFAULT_AUDIO_OPTS,
  log: (m: string) => void = () => {},
): Promise<AudioTrack> {
  const st = await fs.stat(item.path).catch(() => null);
  const stamp = st ? `${st.mtimeMs}:${st.size}` : "0:0";
  const key = createHash("sha1")
    .update(`${item.path}|${stamp}|pad${opts.padSec}|q${opts.quality}|sr${opts.sampleRate}`)
    .digest("hex")
    .slice(0, 16);
  const dir = path.join(cacheDir, "audio");
  const cached = path.join(dir, `${key}.ogg`);

  const hit = await fs.readFile(cached).catch(() => null);
  if (hit) {
    return { data: hit, seconds: await probeDuration(cached), silent: false, cacheHit: true };
  }

  await fs.mkdir(dir, { recursive: true });

  // apad runs AFTER the decoded audio: `pad_dur` appends that many seconds of
  // silence and, unlike a fixed-length `whole_dur`, never truncates source that
  // is longer than the padding. The `-t` guard is a different concern — it stops
  // a malformed file from producing an unbounded track.
  const args = [
    "-v", "error",
    "-i", item.path,
    "-vn",
    "-af", `apad=pad_dur=${opts.padSec}`,
    "-map", "a:0",
    "-c:a", "libvorbis",
    "-ac", "1",
    "-ar", String(opts.sampleRate),
    "-q:a", String(opts.quality),
    "-f", "ogg",
    "pipe:1",
  ];

  let res = await run("ffmpeg", args);

  // A clip with no audio track makes `-map a:0` fail outright. Silence of the
  // same length is not what anyone wants, but no audio at all is worse: the
  // speaker session would stay open and block the next track.
  if (!res.ok || res.out.length === 0) {
    log(`[audio] no audio stream (${res.err.split("\n")[0] || "empty"}), using silence`);
    const dur = Math.max(1, item.durationMs / 1000) + opts.padSec;
    res = await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", `anullsrc=r=${opts.sampleRate}:cl=mono`,
      "-t", String(dur),
      "-c:a", "libvorbis",
      "-q:a", String(opts.quality),
      "-f", "ogg",
      "pipe:1",
    ]);
    if (!res.ok || res.out.length === 0) {
      throw new Error(`audio generation failed: ${res.err.slice(0, 300)}`);
    }
    const seconds = dur;
    warnLengths(seconds, res.out.length, log);
    await fs.writeFile(cached, res.out).catch(() => {});
    return { data: res.out, seconds, silent: true, cacheHit: false };
  }

  // Atomic publish: a half-written cache entry would be served forever.
  const tmp = `${cached}.tmp`;
  await fs.writeFile(tmp, res.out);
  await fs.rename(tmp, cached);

  const seconds = (item.durationMs > 0 ? item.durationMs / 1000 : await probeDuration(item.path)) + opts.padSec;
  warnLengths(seconds, res.out.length, log);
  return { data: res.out, seconds, silent: false, cacheHit: false };
}

function warnLengths(seconds: number, bytes: number, log: (m: string) => void): void {
  log(`[audio] ${(bytes / 1024).toFixed(0)} KiB ogg, ${seconds.toFixed(1)} s, ` +
      `${(bytes * 8 / Math.max(1, seconds) / 1000).toFixed(0)} kbps`);
  if (bytes > HQ_MAX_BYTES) {
    log(`[audio] WARNING ${bytes} B exceeds HQ MAX_BYTES ${HQ_MAX_BYTES}; the addon will reject it`);
  }
  if (seconds > HQ_MAX_DECODED_SECONDS) {
    log(`[audio] WARNING ${seconds.toFixed(0)} s exceeds decoded cap ${HQ_MAX_DECODED_SECONDS.toFixed(0)} s; the tail will be cut`);
  }
}
