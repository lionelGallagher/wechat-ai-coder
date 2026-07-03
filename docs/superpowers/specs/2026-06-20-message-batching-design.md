# 微信消息分块优化：按回合分流最终答案

**日期**：2026-06-20
**作者**：brainstorming session
**状态**：待评审

## 1. 问题陈述

当前流式推送逻辑把 Claude CLI 的所有 `text_delta` 一视同仁地按"段落边界"切割推送，导致**最终答案也被切成大量碎片**。

真实 trace 验证（`/tmp/claude-stream-test/traces/`）：

| Trace | 场景 | 现状推送条数 |
|---|---|:---:|
| A | 纯文本 Q&A（1485 字） | **8 条** |
| D | tool_use + 9121 字长答案 | **59 条** |

Trace D 的 59 条会反复撞服务端 ~10 条/分钟的突发限制（`ret:-2`），触发多次 60s 冷却，**累计卡顿 5-6 分钟**。这是用户报告的"体验特别差"的根因。

## 2. 目标与非目标

### 目标

- **最终答案**（Claude 给用户的交付内容）尽可能合并成最少条消息，仅在超过微信单条 4000 字硬上限时按段落边界切分。
- **Agent loop 期间的 interstitial**（工具调用之间的简短评注）保持现状的实时段落推送，不引入额外延迟。

### 非目标

- **不改限流逻辑**。`api.ts` 的 2.5s 间隔、60s 冷却、指数退避全部保持现状。理由：Problem 1 修复后发送量大幅下降（D 场景 59 → 4），足以让绝大多数任务在突发限制以内完成；用户已确认接受重度 agent loop（10+ 工具调用 + 密集 interstitial）仍可能撞墙的边界情况。
- 不改 `splitMessage` 的 4000 字上限。
- 不改 typing 指示器、silence warning（5min 兜底）、文件自动推送等机制。

## 3. 根因分析

`src/main.ts:574-590` 的 `onText` 回调对每个 `text_delta` 执行同一段 flush 判断：

```ts
const shouldFlush =
  (endsWithStructuralBoundary(textBuffer) && textBuffer.trim().length >= MIN_BATCH_FLUSH_LEN)
  || textBuffer.length > SOFT_FLUSH_LIMIT;
```

这段逻辑同时作用于两类语义不同的文本：

1. **Interstitial**：agent 在工具调用之间吐出的简短进度（"让我看一下代码"、"找到问题了"）。
2. **Final answer**：回合自然结束时交付给用户的完整回答。

两者都被段落边界切分。`src/main.ts:610-621` 虽然有"整段重发"分支，但条件是 `!anySent`——只要流式期间推过任何内容就不再触发，所以最终答案只能依靠流式 flush，被切成 N 段。

## 4. 关键洞察：`stop_reason` 是明确的回合类型信号

抓取真实 NDJSON trace（`claude -p - --output-format stream-json --verbose --include-partial-messages`）后发现：**每个 assistant 回合结束时会发 `message_delta` 事件，带明确的 `stop_reason` 字段**。

| `stop_reason` | 含义 | 文本应如何处理 |
|---|---|---|
| `"tool_use"` | 回合因要调工具结束，agent loop 继续 | 按段落 flush（interstitial） |
| `"end_turn"` | 自然结束，这就是最终答案 | **整回合 buffer，流结束才一次性发** |
| `"max_tokens"` / `"stop_sequence"` / `"pause_turn"` | 非自然结束但属终态 | 同 `end_turn` |

这比早期讨论的"是否有 tool_use"启发式更可靠——不需要猜测、不需要特例处理纯 Q&A 场景，API 直接告诉我们这回合是什么。

## 5. 设计

### 5.1 状态机

`sendToClaude` 内部维护三个局部状态（替换现在的单个 `textBuffer`）：

```ts
let turnBuffer = '';        // 当前回合累积的 text_delta
let pendingFinal = '';      // 标记为最终答案的回合文本（可能跨多个 end_turn 回合）
let anySent = false;        // 是否曾成功推送（保留现有安全网语义）
```

### 5.2 事件路由

**`onText(delta)`**：每个 `text_delta` 追加到 `turnBuffer`。**不再做段落边界 flush 判断**——段落 flush 推迟到回合结束时根据 `stop_reason` 决定。

**`onTurnEnd(stopReason)`**（新回调，由 `provider.ts` 在 `message_delta` 事件时触发）：

```ts
const turnText = turnBuffer;
turnBuffer = '';

if (stopReason === 'tool_use') {
  // interstitial：按段落边界 flush（保留 agent loop 进度的实时性）
  await flushInterstitial(turnText);
} else {
  // end_turn / max_tokens / 等：标记为最终答案，不立即发
  pendingFinal += (pendingFinal && turnText) ? '\n\n' : '';
  pendingFinal += turnText;
}
```

**流结束**（`claudeQuery` 返回后）：

```ts
// 1. 先发最终答案（splitMessage 按 4000 字硬切，自然按段落打包）
await flushFinal(pendingFinal);
// 2. drain 残留 interstitial（保险）
await flushInterstitial(turnBuffer);
// 3. 安全网：完全没流式过任何内容时，用 result.text 整段发
if (!anySent && result.text) {
  for (const chunk of splitMessage(result.text)) await sender.sendText(...);
}
```

### 5.3 `flushInterstitial` 与 `flushFinal`

两者都复用现有 `flushChain`（串行 promise 链）保证发送顺序，都调用 `splitMessage`：

- `flushInterstitial(text)`：把 text 通过 `splitMessage` 切（对长 interstitial 也能处理），逐块 `sender.sendText`。
- `flushFinal(text)`：同上。差别只在**调用时机**——interstitial 在回合结束立即调用，final 只在流结束调用。

实现上可以参数化合并成一个 `flush(text, role)` 函数，role 仅用于日志区分。

### 5.4 边界情况

| 场景 | 行为 |
|---|---|
| 纯 Q&A（无 tool_use，单回合 end_turn） | 所有文本进 `pendingFinal`，流结束一次性发。**这正是 Trace A 的 8→1**。 |
| Agent 多轮 tool_use 后给最终答案 | 每个 tool_use 回合的文本立即当 interstitial 推；最后的 end_turn 回合 buffer 到流结束一次性推。 |
| 最终答案超 4000 字 | `splitMessage` 按段落边界硬切成 N 块（N = ceil(字数/4000)）。Trace D 的 9121 字 → 3 块。 |
| 多个 end_turn 回合（罕见，如 `pause_turn` 后续接 end_turn） | 用 `\n\n` 连接累积到 `pendingFinal`，结束时一起发。 |
| Abort（被新消息打断） | `provider.ts` 现有 `onAbort` 捕获 `partialText` 返回。`sendToClaude` 的 `finally` 会 drain 两个 buffer（interstitial + final）；被打断时部分最终答案也能推送给用户，不丢内容。 |
| 流式完全失败（`onText` 从未触发） | `anySent` 保持 false，安全网分支用 `result.text` 整段发（沿用现有逻辑）。 |

### 5.5 不变的部分

- `splitMessage` / `parseBlocks` / `findSafeSplitPoint` / `splitByNewline`：完全不动，仍是最终切分手段。
- `MAX_MESSAGE_LENGTH = 4000`：不动。
- silence warning 5min 兜底（`flushTimer`）：保留。长最终答案生成期间 typing 指示器 + 5min 兜底仍在。
- `result.text` 写入 chat history：不变。
- `api.ts` 限流逻辑：不变。

### 5.6 删除的死代码

新方案不再需要按段落边界判断 flush 时机，以下符号变成死代码，一并删除（遵循项目"不留无用符号"规范）：

- `MIN_BATCH_FLUSH_LEN`（常量）
- `SOFT_FLUSH_LIMIT`（常量）
- `endsWithStructuralBoundary`（函数）

`onBlockEnd` 回调也不再需要——回合边界由 `onTurnEnd` 接管。`QueryOptions.onBlockEnd` 字段从 `provider.ts` 删除，`main.ts` 不再传它。

## 6. 改动文件

| 文件 | 改动 |
|---|---|
| `src/claude/provider.ts` | `stream_event` 分支里，`message_delta` 事件触发新回调 `onTurnEnd(stopReason)`。`QueryOptions` 增加可选字段 `onTurnEnd?: (stopReason: string) => void`，**删除** `onBlockEnd` 字段及对应的 `content_block_stop` 分支调用（不再需要）。 |
| `src/main.ts` | `sendToClaude` 内：把单个 `textBuffer` 拆成 `turnBuffer` + `pendingFinal`；`onText` 只累积不 flush；新增 `onTurnEnd` 路由；流结束顺序改为先 `flushFinal` 再 `flushInterstitial`；**删除** `MIN_BATCH_FLUSH_LEN`、`SOFT_FLUSH_LIMIT`、`endsWithStructuralBoundary`、`onBlockEnd` 入参。`splitMessage` 等辅助函数不动。 |

**改动量预估**：`provider.ts` 加约 5 行（一个 case 分支 + 类型定义）- 3 行（删 onBlockEnd）；`main.ts` 改约 30-40 行（路由重写）+ 删约 15 行（死代码）。净增量小。

## 7. 验证计划

### 7.1 单元测试

- `splitMessage` 行为不变（现有测试继续通过）。
- 新增：构造模拟的 `turn` 序列，验证 `simulateProposed` 对各种 `stop_reason` 组合的分流正确。

### 7.2 集成验证（用真实 trace 回放）

复用本次 brainstorming 期间的模拟器 `/tmp/claude-stream-test/simulate.mjs`，把 `provider.ts` 改完后的真实输出再抓一次 trace，确认推送条数符合预期：
- 纯 Q&A → 1 条
- 多 tool_use + 最终答案 → interstitial 数 + 1（或按 4000 字切的 N 块）

### 7.3 手测（微信端）

1. 在微信里发"用三段话解释闭包"→ 应该收到 1 条完整答案（而非现在的 8 条）。
2. 发"分析 src/main.ts 的结构"→ 应该收到 1 条 interstitial + 3 条最终答案块（而非现在的 59 条）。
3. 发一个会触发 abort 的任务（`/stop`）→ 已推的 interstitial 不丢，未发的最终答案部分按已生成的部分推送。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Agent 单回合内既有长文本又有 tool_use（如先写 500 字解释再调工具） | 文本会延迟到回合结束（看到 `stop_reason=tool_use`）才作为 interstitial 推送。延迟量级 = 回合内文本生成时间，通常几秒。silence warning 5min 兜底覆盖极端情况。 |
| `message_delta` 事件因 CLI 异常未触发 | 流结束时的 `flushFinal(pendingFinal)` + `flushInterstitial(turnBuffer)` 兜底 drain，任何已累积的文本都不会丢。 |
| `stop_reason` 取值未来扩展（新枚举） | 默认走 `else` 分支当最终答案处理——对新值也是安全选择（宁可少切也不丢内容）。 |
| Interstitial 过长（agent 在工具间吐大段评注） | `flushInterstitial` 走 `splitMessage`，会按 4000 字硬切。行为与现状一致。 |

## 9. 未来可考虑的改进（不在本次 scope）

- **限流改造**：如果 Problem 1 修复后重度 agent loop 仍频繁撞墙，再考虑把 `api.ts` 的固定间隔改成 60s 滑动窗口（~8 条上限）。
- **长最终答案期间的进度反馈**：用户当前选择"完全等完再发"。若未来希望长答案期间有部分漏出，可在 `pendingFinal` 超过某阈值（如 5000 字）或等待超过 60s 时，主动 flush 一次部分内容。
- **更激进的 interstitial 合并**：把连续多个 tool_use 回合的 interstitial 攒到一起发，进一步减少条数。代价是 agent loop 实时性下降。
