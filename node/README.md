# node/ · 公网侧

两件事：**离线把视频转成 `.ccv`**，**把码流通过 wss 分发给 CC**。

单包，`"private": true`，**不发布 npm**。`tsc` 编到 `dist/`，`node dist/xxx` 直接跑。

## 目录（规划）

```
node/
├── package.json         private:true，依赖只有 ffmpeg 可执行文件（不装 npm 视频库）
├── tsconfig.json
├── src/
│   ├── protocol.ts      ccv v1 的常量、编解码（与 docs/01 一一对应）
│   ├── transcode.ts     离线转码：视频 → 分块/MV 分析 → .ccv
│   ├── verify.ts        逐帧 encode→decode 位精确校验（强制步骤）
│   ├── serve.ts         wss 分发 + room/quadrant 锁步 + ack
│   ├── library.ts       .ccv 与 meta.json 的扫描
│   └── util/            大端读写、日志
└── dist/                构建产物（.gitignore）
```

## 依赖策略

| 需要 | 怎么满足 |
|---|---|
| 解任意视频容器/编码 | **外调 ffmpeg**（`child_process`），输出 `rgb24` raw 到管道 |
| 分块 / 块匹配 / 打包 | **自己写**，纯 TS，无依赖 |
| wss | `ws`（唯一运行时依赖） |
| HTTP `/health` | 内置 `node:http` |

不引入 fluent-ffmpeg / sharp / ffmpeg.wasm 之类的封装：目标环境就一个 VPS，直接调二进制最省事、最好排障。

## 命令（规划）

```bash
npm run build
node dist/transcode --in movie.mp4 --out videos/movie --wall 640x360 --fps 20 --profile 1
node dist/verify    --in videos/movie
node dist/serve     --dir videos --port 18755
curl -s localhost:18755/health
```

## 与 CC 的契约

线上字节格式**只**由 [`../docs/01-码流格式.md`](../docs/01-码流格式.md) 定义。
`src/protocol.ts` 是它的唯一实现，任何字段改动必须先改文档再改代码（顺序不能反）。

## 状态

**尚未实现。** 先完成 `docs/06` 的 §1/§2/§3 三项实测，再动 `transcode.ts`。
