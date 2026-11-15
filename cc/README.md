# cc/ · 游戏内 Lua

每台 CC 只负责一个 `region`。第一版 2×2，全局 640×360，每块 320×180。

## 目录（规划）

```
cc/
├── wall.lua       入口：读配置、找 hologram、连 ws、进事件循环
├── decoder.lua    把一条 FRAME 消息解成若干 blit 调用（P1）
├── renderer.lua   持有 prev/cur、调 blit、回 ack
├── master.lua     收 ack、调 h.sync()、fabric 广播
├── link.lua       ws 重连、保活、PING/PONG
└── wall.cfg       每台电脑一份（textutils.serialise，**不带 return**）
```

## 硬性约束（来自 `docs/02` 的实测）

1. **禁止每像素 Lua 循环。** 解码只能是「整块 `string.sub` + 一次转表 + 一次 blit」。
   每多一次逐像素运算，就会把 20 fps 推到个位数。
2. **禁止常驻大表。** 4096 元素的表用完即弃；只保留 `prev` 字符串（57.6 KB）。
3. **不要用 framebuffer**（`allocateFrameBuffer`）。它存在方块实体里、电脑重启不释放，
   上一代因此把槽位占满。直接 blit 显示缓冲。
4. **只有 master 调 `h.sync()`。**
5. **不要靠 timer 驱动帧节奏。** hologram 的主线程 API 会吞排队事件；用「消息到达」驱动，
   服务器每 200 ms 的 `PING` 就是为此存在。

## 电子盘注意

- CC 电脑磁盘默认 1 MB；**不要**往电脑上放视频/码流文件，码流只走 ws 不落盘。
- 换脚本后必须重启电脑才生效（CC 只在开机读 `startup.lua`）。
- 日志要能关（`wall.cfg` 的 `log`），长期跑会吃满磁盘。

## 状态

**尚未实现。** 先跑 `docs/06` §1 的探针（`blit` 是否吃字符串），它决定 `decoder.lua` 的写法。
