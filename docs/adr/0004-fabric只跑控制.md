# ADR-0004 · 像素走 ws，fabric 只跑控制

- 状态：**已接受**
- 日期：2026-11-15
- 相关：[`../04-多屏拼接与同步.md`](../04-多屏拼接与同步.md)

## 背景

用户提出「渲染机和主机之间主要靠 fabric 通信」。这需要拆成两个问题：

1. **像素**能不能走 fabric？
2. **同步/控制**走 fabric 合适吗？

## 实测：fabric 的额度是「每发送机」

来自 jar（`computercraft_cee_addon-1.0.0_86f9ab3`）与配置 `config/computercraft_cee_addon-common.toml`：

| 项 | 值 | 含义 |
|---|---|---|
| `sizeOf(String)` | `16 + 2N` 字节 | 计费口径 |
| `bulkBytes` | 512 | 超过即计入 bulk 额度 |
| `bulkTokensPerTick` | **8** | 每台**发送机**每 tick 的大包数 |
| `sendTokensPerTick` | 32 | 每台发送机每 tick 的总消息数 |
| `bulkIngressPercent` | 50 | 大包最多占接收队列的一半 |
| `ingressDrainPerTick` | 32 | 每台电脑每 tick 交出的事件数 |
| `ingressCapacity` | 256 | 接收队列上限（满了**拒收**，不静默丢） |

单机每分钟可搬：`8 条/tick × 20 tick/s × 7.2 KB/条 ≈ 1.15 MB/s`。

**一块 320×180@20fps 的压缩码流**（按 ADR-0003 的典型帧 5 块变化）：
`5 × 4096 B × 20 fps ≈ 400 KB/s` —— 勉强可以，但：

- 额度按**发送机**计，不按接收机：一台 master 要给 3 台渲染机发，**共享这份 1.15 MB/s**；
- 接收侧 `ingressDrainPerTick = 32`，若一帧要拆成 2 条大包 × 20 fps = 40 条/s，尚可，
  但再加上控制消息就会触到上限；
- `sizeOf` 是 `16 + 2N`，即**字符串按 UTF-16 计费**：4096 B 的二进制串要按 8192 计 ⇒ 实际**额度腰斩到 0.58 MB/s**；
- 一旦超限，接收方**拒收**（`ingressCapacity` 满）或事件被丢弃，表现为「偶发整块不更新」，极难排查。

⇒ **像素走 fabric 会把「带宽」从「公网问题」变成「CC 事件队列问题」，而且余量为零。**

## 决策

| 通道 | 承载 |
|---|---|
| **CC `http.websocket`** | 像素码流（每台渲染机各一条 ws，直连公网 Node） |
| **CEE `fabric`** | 帧号 ack、`go` 栅栏、播放/暂停状态、按键 —— **每帧几字节** |

即：**fabric 不再搬运「内容」，只搬运「时序」。**

## 理由

1. **余量**：ack 是 20 fps × 4 台 = 80 条/s，摊到每 tick 约 4 条，对 `sendTokensPerTick=32` 有 8 倍余量；
   且 payload 只有 10 余字节，不算 bulk，不占用 `bulkTokens`。
2. **职责单一**：fabric 的强项是「金脚直连、低延迟、无需外网」，正好适合「必须同一 tick 内对齐」的活儿；
   ws 的强项是带宽，适合搬字节。
3. **隔离故障**：像素走 ws，某台网络抖动只影响自己；若像素走 fabric，一台堵住会占满共享额度、拖垮全墙。
4. 与上一代一致（它也是 ws 搬像素、CC 间零同步），风险已知。

## 后果

**好**

- 每台渲染机独立连公网，互不影响；新增一台屏只是多一条 ws。
- fabric 流量极小，`ingress` 永远不会满。
- MC 服务器不需要知道墙的存在。

**坏 / 代价**

- **不再是「单点进入」**：N 台电脑要各自能访问公网 ws（`http.rules` 必须放行域名）。
  本服 `host="*" allow`，无需改配置；若将来收紧白名单，要逐台确认。
- Node 侧要维护 N 条连接与「同一 room 的 quadrant 集合」，锁步逻辑在 Node 而不是 CC（见 `docs/04` §3.1(a)）。

## 什么时候该重新考虑

若出现下列任一情况，可重新评估「像素走 fabric + 单台喂食机」：

- MC 服务器**禁止** CC 访问公网（只允许局域网）；
- 公网带宽成本成为主要问题，而局域网带宽充裕；
- 单 room 的渲染机数量很少（1–2 台）且能接受零余量。

此时形态是：**一台「喂食机」连 ws 收码流，经 fabric 分发给各渲染机**——
注意它受同一份 `bulkTokensPerTick=8` 限制，**一台喂食机最多喂一块 320×180**，因此每块屏都要配一台喂食机。

## 证据

| 事实 | 来源 |
|---|---|
| `sizeOf(String) = 16 + 2N`，bulk 阈值 512 | jar 内 `CEENetwork.sizeOf` 字节码 |
| `bulkTokensPerTick=8`、`sendTokensPerTick=32`、`ingressCapacity=256`、`ingressDrainPerTick=32`、`bulkIngressPercent=50` | `config/computercraft_cee_addon-common.toml` 的 `[network]` / `[bulk]` 段 |
| `fabricSend`/`fabricBroadcast` 只投递给**开机的电脑**，返回「成功投递数」 | jar 内 `CEEComputerApi.fabricBroadcast` 字节码 |
| ws 单消息 128 KB、`global_download` 32 MB/s、host `*` 放行 | `config/computercraft-server.toml` |
