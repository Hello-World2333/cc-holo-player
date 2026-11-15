/**
 * 视频封面：抽一帧、缩到 128x72、量化成 hologram 的 blit 格式，并落盘缓存。
 *
 * 抽帧要 fork 一次 ffmpeg（几十到几百毫秒），列表页一次要 30 张，
 * 所以缓存必须比量化本身更优先考虑。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { quantize } from "./codec.js";
import type { LibItem } from "./library.js";

export const THUMB_W = 128;
export const THUMB_H = 72;

/** ffmpeg 交出来的是 rgb24，每像素 3 字节。 */
const RAW_BYTES = THUMB_W * THUMB_H * 3;
/** 量化后每像素 1 字节。 */
const PACKED_BYTES = THUMB_W * THUMB_H;

function stderrHead(s: string, lines = 3): string {
  return s.trim().split("\n").slice(0, lines).join(" | ");
}

/**
 * 缓存文件名：path + mtime。带上 mtime 是因为同名文件被重新转码后必须重新抽帧，
 * 否则封面会永远是旧片子的那一帧。
 */
function thumbCacheName(item: LibItem): string {
  let stamp: string;
  try {
    const st = fs.statSync(item.path);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // 文件暂时读不到（共享盘没挂上）时退化成时长，key 仍然稳定，至少不会写出两份缓存。
    stamp = `duration:${item.durationMs}`;
  }
  return `${createHash("sha1").update(`${item.path}|${stamp}`).digest("hex")}.bin`;
}

interface FfmpegFrame {
  raw: Buffer;
  stderr: string;
}

function extractFrame(item: LibItem): Promise<FfmpegFrame> {
  // 35% 处比第一帧有代表性得多：片头经常是纯黑或标题卡。
  const seconds = Math.max(0, (item.durationMs / 1000) * 0.35);
  return new Promise((resolve, reject) => {
    const p = spawn(
      "ffmpeg",
      [
        "-v", "error",
        "-nostdin",
        "-ss", seconds.toFixed(3),
        "-i", item.path,
        "-frames:v", "1",
        "-vf",
        `scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=decrease:flags=area,` +
          `pad=${THUMB_W}:${THUMB_H}:(ow-iw)/2:(oh-ih)/2:color=black`,
        "-an", "-sn", "-dn",
        "-pix_fmt", "rgb24",
        "-f", "rawvideo",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    let stderr = "";
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    // 只留开头几行：ffmpeg 真正的失败原因在第一行，后面全是解码器噪声。
    p.stderr.setEncoding("utf8").on("data", (c: string) => {
      if (stderr.length < 4096) stderr += c;
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exit ${code}: ${stderrHead(stderr) || "(empty stderr)"}`));
        return;
      }
      resolve({ raw: Buffer.concat(chunks), stderr });
    });
  });
}

/**
 * 一张封面的紧凑像素数据：THUMB_W*THUMB_H 字节，每像素 1 字节 RRGGBBAA（每通道 2 bits）。
 * 这就是 hologram 的 blit 直接吃的格式。
 */
export async function getThumbnail(item: LibItem, cacheDir: string): Promise<Buffer> {
  const dir = path.join(cacheDir, "thumbs");
  const file = path.join(dir, thumbCacheName(item));

  try {
    const hit = await fs.promises.readFile(file);
    // 长度不对说明上次写到一半就断了（或旧版本格式），重抽比返回错尺寸的像素安全。
    if (hit.length === PACKED_BYTES) return hit;
  } catch {
    // 未命中是最常见的情况，读失败一律当作没有缓存。
  }

  const { raw, stderr } = await extractFrame(item);
  if (raw.length !== RAW_BYTES) {
    throw new Error(
      `thumbnail ${item.title}: ffmpeg produced ${raw.length} raw bytes, want ${RAW_BYTES}` +
      (stderr ? ` (${stderrHead(stderr)})` : ""),
    );
  }

  const packed = Buffer.from(quantize(raw, THUMB_W, THUMB_H, { dither: "none" }));

  // 先写临时文件再 rename：并发请求同一张封面时，别的进程不会读到半截文件。
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmp, packed);
    await fs.promises.rename(tmp, file);
  } catch {
    // 缓存只是加速：目录只读或磁盘满时封面仍然要能用，失败就放弃这一份缓存。
    await fs.promises.unlink(tmp).catch(() => {});
  }

  return packed;
}
