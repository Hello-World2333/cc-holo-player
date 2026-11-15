# cc/ · 游戏内 Lua

一台 CC 电脑负责**一整块 640×360 hologram**（见 `docs/adr/0007`）。

| 文件 | 作用 |
|---|---|
| `wall.lua` | 入口：读配置、找 hologram、连 ws、事件循环、重连 |
| `decoder.lua` | 把一条 `FRAME` 消息画到显示缓冲（MV 走 Java 拷贝，RAW 走 blit） |
| `wall.cfg` | 部署时生成，**不在仓库里**（含 token） |

## 部署

电脑的「磁盘」就是世界存档里的一个目录，可以直接写进去（服务器开着也行，开机时才读）：

```bash
tools/deploy.sh 81                 # 复制脚本 + 生成 startup.lua
$EDITOR /mnt/data/linyun/hkx-simple/world/computercraft/computer/81/wall.cfg
```

### ⚠️ 先扩容，否则 `out of space`

CEE:CC 的**机架式电脑只有 4 KB** 磁盘（`fs.getCapacity("/") == 4096`），
本目录三个文件就 ~9 KB，必然存不下。用「黑魔法」充值一次即可，
详见 [`../docs/05-部署.md`](../docs/05-部署.md) §3.2。简述：

```bash
cd world/computercraft/computer/<id>
truncate -s 1073741824 padsize      # 名义 1 GiB、实际 0 字节的稀疏文件
```

```lua
-- startup.lua 第一行
if fs.exists("/padsize") then fs.delete("/padsize") end
```

重启后 `fs.getFreeSpace("/")` ≈ 1 GiB，且**跨重启保持**。`capacity` 仍是 4096，
变的是已用量被压成负数。

`wall.cfg` 格式（`textutils.serialise`，**不带 `return`**）：

```lua
{ url  = "ws://10.0.0.5:18755/play?token=dev",
  name = "mimi",
  log  = true }
```

改完脚本或配置后**必须重启电脑**（`Ctrl+R` 或 `computercraft shutdown/turn-on`），
CraftOS 只在开机时读 `startup.lua`。

## 硬性约束

1. **禁止每像素 Lua 循环。** MV 必须是 `blitFrameBufferArea`（一条 Java 调用）；
   RAW 的「串→表」是唯一的逐像素代码，且必须 16 字节一批（实测快 3 倍）。
2. **不要用 framebuffer 做双缓冲。** 只分配 1 个给 `prev`，显示缓冲用 `-1`。
3. **只有一台电脑能碰这个 hologram。** 外设实例是共享的，「当前激活缓冲」是它上面的单个字段。
4. **不要靠 timer 驱动帧节奏。** 用消息到达驱动；服务器每 200 ms 发 `PING`。
5. 换脚本必须重启电脑。

## 验证

`tools/lua_conformance.mjs` 在 Lua VM 里跑本目录的 `decoder.lua`，
与 `node/src/codec.ts` 的参考解码器逐像素对比。**改解码器后必须跑它。**
