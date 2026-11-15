# tools/ · 基准与验证

这个项目的正确性无法靠「看起来能播」判断（码流是自己定的，没有现成播放器可比对），
所以工具不是附加项，是必需项。

## 规划

| 工具 | 用途 | 何时写 |
|---|---|---|
| `probe_shared_instance.lua` | **测 4 台是否共享同一个 hologram 外设实例**（`docs/06` §1，唯一阻塞项） | **第一个写** |
| `bench_fbcopy.lua` | 240 次 `blitFrameBufferArea` 的中位耗时（`docs/06` §2） | 同上，20 行 |
| `bench_blit_size.lua` | 256/1024/4096 项表的 `blit` 成本，拟合「每像素 + 每次调用」（`docs/06` §3） | 同上 |
| `bench_decode.lua` | 喂合成的 FRAME，量单帧解码耗时与 GC | 解码器之后 |
| `ccv_dump.ts` | 把 `.ccv` 打成人类可读的逐帧逐块清单 | 编码器之前（先定格式） |
| `ccv_replay.ts` | 在 Node 里跑一遍解码器（参考实现），输出 PNG 序列 | 编码器同期，用于看画质 |
| `conformance/` | 固定输入 → 固定码流 → 固定输出的回归集 | 协议定稿后立刻建 |

## 为什么 `ccv_replay` 重要

`docs/02` §5 要求「编码器必须能逐像素复现解码器的结果」。
在 Node 里实现一份**参考解码器**，就能：

- 把 `.ccv` 渲染成 PNG，人眼评估画质（不用每次都进游戏）；
- 与真机 CC 的输出逐字节对比，定位「是码流错了还是 Lua 实现错了」；
- 作为 `conformance` 的金标准。

## 已经不需要的工具

初稿计划了 `probe_blit_string.lua`（测 `blit` 是否吃字符串）与 `bench_cur.lua`
（整串 vs 按行表）。反编译 `void_power-1.0.7.fix2.jar` 之后**两者都作废**：

- `blit` 只吃 `IArguments.getTable(4)` → `Map`，**不接受字符串**；
- MV 改走 `blitFrameBufferArea`（纯 Java 拷贝），Lua 侧根本不维护帧数据。

见 `../docs/adr/0006`。

## 状态

**尚未实现。** 第一个要写的是 `probe_shared_instance.lua`——它回答的是
「4 台电脑能不能安全地各自分配 framebuffer」，答错的话整个多机架构要重做。
