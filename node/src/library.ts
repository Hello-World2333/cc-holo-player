/**
 * 媒体库扫描：文件名 -> 可进协议的 key + 标题 + 时长。
 *
 * 时长只能靠 ffprobe 拿，单次约 320ms；31 个文件就是 10s。这笔钱每个进程只该付一次，
 * 所以时长按 (mtimeMs, size) 持久化在 cacheDir 里。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface LibItem {
  /** 稳定 ASCII id，8 位小写 hex，由文件名 sha1 前 8 位得到。CJK 不能进协议。 */
  key: string;
  /** 显示标题：文件名去掉扩展名，保留原始 UTF-8 */
  title: string;
  /** 绝对路径 */
  path: string;
  durationMs: number;
}

const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"]);

/** 文件名 -> 8 位 hex，供别处（缓存键、协议）复用，保证全项目同一套 id。 */
export function libKey(fileName: string): string {
  return createHash("sha1").update(fileName, "utf8").digest("hex").slice(0, 8);
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  durationMs: number;
}

type CacheFile = Record<string, CacheEntry>;

/**
 * 4 路足够把 31 个 probe 的墙钟时间压到 ~2.5s；再高就是和这台共享机器上的其他
 * 进程抢磁盘，单次 probe 反而变慢。
 */
const PROBE_CONCURRENCY = 4;
const WATCH_DEBOUNCE_MS = 500;

function isVideo(name: string): boolean {
  return VIDEO_EXTS.has(path.extname(name).toLowerCase());
}

/** `-v error` 下 stderr 只有真正的失败原因，留前几行就够定位。 */
function stderrHead(s: string, lines = 3): string {
  return s.trim().split("\n").slice(0, lines).join(" | ");
}

function probeDurationMs(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    p.stdout.setEncoding("utf8").on("data", (c: string) => { out += c; });
    p.stderr.setEncoding("utf8").on("data", (c: string) => { err += c; });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) {
        const head = stderrHead(err);
        reject(new Error(`ffprobe exit ${code}${head ? `: ${head}` : ""}`));
        return;
      }
      const secs = Number.parseFloat(out.trim());
      // 有些容器（尤其是没写完的 mkv）会把 duration 报成 N/A。
      if (!Number.isFinite(secs) || secs <= 0) {
        reject(new Error(`ffprobe gave no usable duration: ${JSON.stringify(out.trim().slice(0, 64))}`));
        return;
      }
      resolve(Math.round(secs * 1000));
    });
  });
}

function sameCache(a: CacheFile, b: CacheFile): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of Object.keys(b)) {
    const x = a[k];
    const y = b[k];
    if (!x || x.mtimeMs !== y.mtimeMs || x.size !== y.size || x.durationMs !== y.durationMs) return false;
  }
  return true;
}

interface ScanRow {
  name: string;
  file: string;
  mtimeMs: number;
  size: number;
  /** 负数 = probe 失败，entry 会被跳过。 */
  durationMs: number;
}

export class Library {
  private readonly dir: string;
  private readonly cacheDir: string;
  private readonly log: (m: string) => void;

  constructor(dir: string, cacheDir: string, log: (m: string) => void) {
    this.dir = dir;
    this.cacheDir = cacheDir;
    this.log = log;
  }

  private get cachePath(): string {
    return path.join(this.cacheDir, "library.json");
  }

  /** 扫描目录，返回按标题（zh-CN locale）排序的条目。只对新增/改动的文件跑 ffprobe。 */
  async scan(): Promise<LibItem[]> {
    const t0 = Date.now();
    const cache = this.loadCache();

    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter(isVideo);
    } catch (e) {
      this.log(`[library] cannot read ${this.dir}: ${(e as Error).message}`);
      return [];
    }

    const rows: ScanRow[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch (e) {
        this.log(`[library] skipping ${name}: ${(e as Error).message}`);
        continue;
      }
      if (!st.isFile()) continue;
      const hit = cache[file];
      const usable = hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size;
      rows.push({
        name,
        file,
        mtimeMs: st.mtimeMs,
        size: st.size,
        durationMs: usable ? hit.durationMs : -1,
      });
    }

    const cold = rows.filter((r) => r.durationMs < 0);
    if (cold.length > 0) {
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next++;
          if (i >= cold.length) return;
          const r = cold[i];
          try {
            r.durationMs = await probeDurationMs(r.file);
          } catch (e) {
            this.log(`[library] skipping ${r.name}: ${(e as Error).message}`);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(PROBE_CONCURRENCY, cold.length) }, () => worker()),
      );
    }

    // 只把成功的写回缓存：probe 失败的文件下次还要重试（也许只是共享盘暂时没挂上）。
    const fresh: CacheFile = {};
    const items: LibItem[] = [];
    for (const r of rows) {
      if (r.durationMs <= 0) continue;
      fresh[r.file] = { mtimeMs: r.mtimeMs, size: r.size, durationMs: r.durationMs };
      items.push({
        key: libKey(r.name),
        title: r.name.slice(0, r.name.length - path.extname(r.name).length),
        path: r.file,
        durationMs: r.durationMs,
      });
    }

    // 删掉的文件也一并出清，否则缓存会随着换片无限长。
    if (!sameCache(cache, fresh)) this.saveCache(fresh);

    items.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    this.log(
      `[library] ${items.length} item(s) in ${Date.now() - t0}ms` +
      ` (${rows.length - cold.length} cached, ${cold.length} probed)`,
    );
    return items;
  }

  /** 监听目录变化，防抖 500ms 后调用 onChange。返回一个 stop 函数。 */
  watch(onChange: () => void): () => void {
    let watcher: fs.FSWatcher | null = null;
    let timer: NodeJS.Timeout | null = null;

    try {
      watcher = fs.watch(this.dir, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          onChange();
        }, WATCH_DEBOUNCE_MS);
      });
      // 目录被删/换挂载点后 fs.watch 会 emit 'error'；没有监听器就是 uncaught exception，
      // 而这个进程同时还在串流，不能因为库目录消失就整个挂掉。
      watcher.on("error", (e) => {
        this.log(`[library] watcher error on ${this.dir}: ${(e as Error).message}`);
      });
    } catch (e) {
      this.log(`[library] cannot watch ${this.dir}: ${(e as Error).message}`);
    }

    return () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    };
  }

  private loadCache(): CacheFile {
    let text: string;
    try {
      text = fs.readFileSync(this.cachePath, "utf8");
    } catch (e) {
      // 首次运行没有文件是正常的；其余读失败也只是让我们多花一次冷扫描。
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log(`[library] cache read failed: ${(e as Error).message}`);
      }
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: CacheFile = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const e = v as Partial<CacheEntry> | null;
        // 手改过或旧版本的条目一律丢弃：错一秒的 durationMs 会让 seek 到错的地方。
        if (!e || typeof e.mtimeMs !== "number" || typeof e.size !== "number" ||
            typeof e.durationMs !== "number" || !Number.isFinite(e.durationMs) || e.durationMs <= 0) {
          continue;
        }
        out[k] = { mtimeMs: e.mtimeMs, size: e.size, durationMs: e.durationMs };
      }
      return out;
    } catch (e) {
      this.log(`[library] cache unreadable, rescanning: ${(e as Error).message}`);
      return {};
    }
  }

  private saveCache(cache: CacheFile): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(cache, null, 2));
    } catch (e) {
      // 缓存写不进去只是下次再冷扫一遍，不能因此让整个库扫不出来。
      this.log(`[library] cache write failed: ${(e as Error).message}`);
    }
  }
}
