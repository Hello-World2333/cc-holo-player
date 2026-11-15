# node/ · 公网侧

单包 TypeScript，`"private": true`，**不发布 npm**（`docs/adr/0005`）。
依赖只有 `ws`，ffmpeg 通过 `child_process` 外部调用。

## 文件

| 文件 | 作用 |
|---|---|
| `src/protocol.ts` | `ccv v1` 的编解码。**唯一**的格式实现，与 `docs/01` 一一对应 |
| `src/codec.ts` | 编码器（块匹配 + RAW/MV 判决）+ 参考解码器 `applyFrame` |
| `src/container.ts` | `.ccv` 容器的读与写 |
| `src/transcode.ts` | 离线转码：ffmpeg → rgb24 → 量化 → 编码 → `.ccv` |
| `src/verify.ts` | 解回来、统计，可选导出 PNG |
| `src/serve.ts` | wss 分发 + ACK 流控 + `/health` |

## 用法

```bash
npm install && npm run build

# 转码（输出 videos/<name>/{video.ccv,meta.json}）
node dist/transcode.js --in movie.mp4 --out videos/movie --fps 20

# 校验（解回来，统计；--png 0,40 导出指定帧）
node dist/verify.js --dir videos/movie --png 0,40

# 分发
node dist/serve.js --dir videos --port 18755
curl -s localhost:18755/health
```

常用参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--w` / `--h` | 640 / 360 | 必须是 `--block` 的整数倍 |
| `--block` | 20 | 块边长。640 与 360 的公因数：20、40、8… |
| `--fps` | 20 | |
| `--mv-mad` | 0.6 | MV 允许的平均误差（0–3 色阶）。越大 MV 越多、码率越低 |
| `--budget` | 25 | 单帧解码预算 ms；超过则拆成多帧（渐进刷新） |

## 两条不变量

1. **`transcode` 每帧都自检**：编码器内部模型与参考解码器必须逐字节一致，
   不一致直接 `exit 2`。这是自定义码流唯一的正确性防线。
2. **`codec.ts` 的 `applyFrame` 必须与 `cc/decoder.lua` 等价**，
   由 `tools/lua_conformance.mjs` 强制验证。

## 为什么 `block` 默认 20

块边长必须同时整除 640 和 360，否则边缘块越界。20 是能整除两者的较大值，
且 32×18 = 576 块在预算内。`--block 16` 会因为 360/16 不整除而被拒绝。
