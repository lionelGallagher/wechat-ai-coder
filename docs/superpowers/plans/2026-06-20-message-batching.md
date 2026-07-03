# 微信消息分块优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Claude CLI 最终答案从"按段落碎片推送"改为"按回合整段推送"，仅在超 4000 字时按段落硬切；agent loop 期间的 interstitial 保持实时段落推送。

**Architecture:** 在 `provider.ts` 暴露 `onTurnEnd(stopReason)` 回调（基于 `message_delta` 事件的 `stop_reason` 字段）；新增 `src/claude/turn-router.ts` 的 `TurnRouter` 类把 `text_delta` 按回合累积，根据 `stop_reason` 分流为 interstitial（立即发）或 final（流结束发）；`main.ts` 替换原 `textBuffer` 逻辑，接入 TurnRouter，删除段落边界 flush 相关死代码。

**Tech Stack:** TypeScript（strict）、Node.js ESM（`"type": "module"`、Node16 module resolution）、Node 内置 test runner（`node --test`）。

## Global Constraints

- 不改 `src/wechat/api.ts` 的限流逻辑（2.5s 间隔、60s 冷却、指数退避保持原样）。
- 不改 `MAX_MESSAGE_LENGTH = 4000`、`splitMessage`、`parseBlocks`、`findSafeSplitPoint`、`splitByNewline`。
- 不改 typing 指示器、silence warning 5min 兜底（`flushTimer`）、文件自动推送。
- TypeScript strict 模式，编译命令 `npm run build`（`tsc`）。
- 测试入口 `npm test` = `node --test dist/tests/*.test.js`，必须先 `npm run build`。
- ESM 导入必须带 `.js` 后缀（即便源是 `.ts`）。
- 提交信息遵循现有风格：`type: 中文描述`（参考 `git log`）。

**Spec 参考**：`docs/superpowers/specs/2026-06-20-message-batching-design.md`

---

## Task 1: 提取 `handleStreamLine` 到 provider.ts（纯重构，为可测性铺路）

**Files:**
- Modify: `src/claude/provider.ts`（提取 `rl.on('line', ...)` 内的 switch 到导出函数）
- Create: `src/tests/provider.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `export interface StreamParserState { sessionId: string; textParts: string[]; errorMessage?: string; trackingSkill: boolean; skillInputAccum: string; }`
  - `export interface StreamParserCallbacks { onText?: (text: string) => void; onBlockEnd?: () => void; }`
  - `export function handleStreamLine(line: string, state: StreamParserState, callbacks: StreamParserCallbacks): void`

- [ ] **Step 1: 写覆盖现有行为的失败测试**

Create `src/tests/provider.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleStreamLine, type StreamParserState } from '../claude/provider.js';

function freshState(): StreamParserState {
  return { sessionId: '', textParts: [], trackingSkill: false, skillInputAccum: '' };
}

test('handleStreamLine: system init 设置 sessionId', () => {
  const state = freshState();
  handleStreamLine(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-123' }),
    state,
    {},
  );
  assert.equal(state.sessionId, 'sess-123');
});

test('handleStreamLine: text_delta 触发 onText', () => {
  const calls: string[] = [];
  handleStreamLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    }),
    freshState(),
    { onText: (t) => calls.push(t) },
  );
  assert.deepEqual(calls, ['hello']);
});

test('handleStreamLine: content_block_stop 触发 onBlockEnd', () => {
  let called = 0;
  handleStreamLine(
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
    freshState(),
    { onBlockEnd: () => called++ },
  );
  assert.equal(called, 1);
});

test('handleStreamLine: assistant 消息文本累积到 textParts', () => {
  const state = freshState();
  handleStreamLine(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '回复内容' }] },
    }),
    state,
    {},
  );
  assert.deepEqual(state.textParts, ['回复内容']);
});

test('handleStreamLine: 空行和非法 JSON 静默跳过', () => {
  const state = freshState();
  handleStreamLine('', state, {});
  handleStreamLine('not json', state, {});
  handleStreamLine('   ', state, {});
  assert.deepEqual(state.textParts, []);
});
```

- [ ] **Step 2: 跑测试确认失败（函数不存在）**

Run:
```bash
npm run build && node --test dist/tests/provider.test.js
```
Expected: 编译错误 `handleStreamLine is not exported` 或测试运行报错 `cannot find module`。

- [ ] **Step 3: 实现提取**

In `src/claude/provider.ts`:

**3a. 在文件顶部 imports 之后、`claudeQuery` 之前，加入类型定义和提取的函数：**

```ts
// ---------------------------------------------------------------------------
// Stream parser (extracted for testability)
// ---------------------------------------------------------------------------

export interface StreamParserState {
  sessionId: string;
  textParts: string[];
  errorMessage?: string;
  trackingSkill: boolean;
  skillInputAccum: string;
}

export interface StreamParserCallbacks {
  onText?: (text: string) => void;
  onBlockEnd?: () => void;
}

export function handleStreamLine(
  line: string,
  state: StreamParserState,
  callbacks: StreamParserCallbacks,
): void {
  if (!line.trim()) return;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  switch (obj.type) {
    case 'system': {
      if (obj.subtype === 'init' && obj.session_id) {
        state.sessionId = obj.session_id;
      }
      break;
    }
    case 'assistant': {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text ?? '')
          .join('');
        if (text) state.textParts.push(text);
      }
      break;
    }
    case 'stream_event': {
      const evt = obj.event;
      if (evt?.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        if (evt.content_block.name === 'Skill') {
          state.trackingSkill = true;
          state.skillInputAccum = '';
        }
      } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        const delta: string = evt.delta.text;
        if (delta && callbacks.onText) {
          callbacks.onText(delta);
        }
      } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && state.trackingSkill) {
        state.skillInputAccum += evt.delta.partial_json ?? '';
        try {
          const parsed = JSON.parse(state.skillInputAccum);
          if (parsed.skill) {
            const msg = `\n正在调用 ${parsed.skill} 技能\n\n`;
            if (callbacks.onText) callbacks.onText(msg);
            state.trackingSkill = false;
          }
        } catch {
          // JSON not complete yet
        }
      } else if (evt?.type === 'content_block_stop') {
        state.trackingSkill = false;
        if (callbacks.onBlockEnd) callbacks.onBlockEnd();
      }
      break;
    }
    case 'result': {
      if (obj.result && typeof obj.result === 'string') {
        const combined = state.textParts.join('');
        if (!combined.includes(obj.result)) {
          state.textParts.push(obj.result);
        }
      }
      if (obj.subtype === 'error' || (obj.errors && obj.errors.length > 0)) {
        const errors = obj.errors ?? [obj.error_message ?? 'Unknown error'];
        state.errorMessage = Array.isArray(errors) ? errors.join('; ') : String(errors);
        logger.error('CLI returned error result', { errors });
      }
      break;
    }
    default:
      break;
  }
}
```

**3b. 在 `claudeQuery` 内替换原 `rl.on('line', ...)` 块。** 找到现有的：

```ts
    // Parse NDJSON from stdout
    let skillInputAccum = '';
    let trackingSkill = false;

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        // Skip unparseable lines
        return;
      }

      switch (obj.type) {
        case 'system': {
          if (obj.subtype === 'init' && obj.session_id) {
            sessionId = obj.session_id;
          }
          break;
        }
        case 'assistant': {
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            const text = content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text ?? '')
              .join('');
            if (text) textParts.push(text);
          }
          break;
        }
        case 'stream_event': {
          const evt = obj.event;
          if (evt?.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
            if (evt.content_block.name === 'Skill') {
              trackingSkill = true;
              skillInputAccum = '';
            }
          } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            const delta: string = evt.delta.text;
            if (delta && onText) {
              Promise.resolve(onText(delta)).catch(() => {});
            }
          } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && trackingSkill) {
            skillInputAccum += evt.delta.partial_json ?? '';
            try {
              const parsed = JSON.parse(skillInputAccum);
              if (parsed.skill) {
                const msg = `\n正在调用 ${parsed.skill} 技能\n\n`;
                if (onText) Promise.resolve(onText(msg)).catch(() => {});
                trackingSkill = false;
              }
            } catch {
              // JSON not complete yet, keep accumulating
            }
          } else if (evt?.type === 'content_block_stop') {
            trackingSkill = false;
            if (onBlockEnd) Promise.resolve(onBlockEnd()).catch(() => {});
          }
          break;
        }
        case 'result': {
          if (obj.result && typeof obj.result === 'string') {
            const combined = textParts.join('');
            if (!combined.includes(obj.result)) {
              textParts.push(obj.result);
            }
          }
          if (obj.subtype === 'error' || (obj.errors && obj.errors.length > 0)) {
            const errors = obj.errors ?? [obj.error_message ?? 'Unknown error'];
            errorMessage = Array.isArray(errors) ? errors.join('; ') : String(errors);
            logger.error('CLI returned error result', { errors });
          }
          break;
        }
        default:
          break;
      }
    });
```

替换为：

```ts
    // Parse NDJSON from stdout (logic in handleStreamLine for testability)
    const parserState: StreamParserState = {
      sessionId: '',
      textParts: [],
      trackingSkill: false,
      skillInputAccum: '',
    };
    const parserCallbacks: StreamParserCallbacks = { onText, onBlockEnd };

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      handleStreamLine(line, parserState, parserCallbacks);
    });
```

**3c. 把所有读写 `sessionId` / `textParts` / `errorMessage` 的地方改成操作 `parserState.*`。** 在 `claudeQuery` 内：

- 函数开头删除三个局部声明：`let sessionId = '';`、`const textParts: string[] = [];`、`let errorMessage: string | undefined;`（状态现在在 `parserState` 里）。
- timeout handler 内：`const partialText = textParts.join('\n').trim();` → `parserState.textParts.join('\n').trim();`；`finish({ ..., sessionId, ... })` → `finish({ ..., sessionId: parserState.sessionId, ... })`。
- onAbort 内：同上两处替换。
- `child.on('close', ...)` 内（5 处替换，含读和写）：
  - `!textParts.length && !errorMessage` → `!parserState.textParts.length && !parserState.errorMessage`
  - `errorMessage = stderr || \`claude exited with code ${code}\`;` → `parserState.errorMessage = stderr || \`claude exited with code ${code}\`;`
  - `const fullText = textParts.join('\n').trim();` → `parserState.textParts.join('\n').trim();`
  - `if (!fullText && !errorMessage)` → `if (!fullText && !parserState.errorMessage)`
  - `errorMessage = 'Claude returned an empty response.';` → `parserState.errorMessage = 'Claude returned an empty response.';`
  - `finish({ text: fullText, sessionId, error: errorMessage })` → `finish({ text: fullText, sessionId: parserState.sessionId, error: parserState.errorMessage })`
  - 日志里 `textLength: fullText.length` 等读取 `fullText` 的不动（它是局部变量）。
- `child.on('error', ...)` 内：`finish({ text: '', sessionId, error: ... })` → `finish({ text: '', sessionId: parserState.sessionId, error: ... })`。

- [ ] **Step 4: 编译并跑测试确认通过**

Run:
```bash
npm run build && node --test dist/tests/provider.test.js
```
Expected: 5 个测试全 PASS，无 TypeScript 编译错误。

- [ ] **Step 5: 端到端冒烟（确认重构没破坏 claudeQuery）**

Run:
```bash
echo "你好" | node dist/main.js 2>&1 | head -5 || true
```
Expected: 进程能启动（即使因为没有配置账号/凭证而退出，也不应在 `provider.ts` 上报 TypeError）。如果输出 `未找到账号` 之类的运行期错误，说明导入和类型正常。

- [ ] **Step 6: 提交**

```bash
git add src/claude/provider.ts src/tests/provider.test.ts
git commit -m "$(cat <<'EOF'
refactor: 提取 handleStreamLine 为可测的纯函数

把 claudeQuery 里 rl.on('line') 的 NDJSON 解析 switch 体抽成独立导出函数
handleStreamLine(line, state, callbacks)，状态外置到 StreamParserState。
行为完全不变，仅是为后续 onTurnEnd 接入和单元测试铺路。

附首批单元测试覆盖 system init / text_delta / content_block_stop /
assistant 文本累积 / 非法行跳过 5 条路径。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 在 provider.ts 加 `onTurnEnd` 回调

**Files:**
- Modify: `src/claude/provider.ts`（`QueryOptions` 加字段、`handleStreamLine` 加分支、`StreamParserCallbacks` 加字段）
- Modify: `src/tests/provider.test.ts`（新增测试）

**Interfaces:**
- Consumes: Task 1 的 `handleStreamLine` / `StreamParserState` / `StreamParserCallbacks`
- Produces:
  - `QueryOptions.onTurnEnd?: (stopReason: string) => void`
  - `StreamParserCallbacks.onTurnEnd?: (stopReason: string) => void`
  - `handleStreamLine` 在收到 `message_delta` 事件且 `delta.stop_reason` 存在时触发 `onTurnEnd`

- [ ] **Step 1: 写失败测试**

Append to `src/tests/provider.test.ts`:

```ts
test('handleStreamLine: message_delta 带 stop_reason 触发 onTurnEnd', () => {
  const calls: string[] = [];
  handleStreamLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    }),
    freshState(),
    { onTurnEnd: (r) => calls.push(r) },
  );
  assert.deepEqual(calls, ['end_turn']);
});

test('handleStreamLine: message_delta 无 stop_reason 不触发 onTurnEnd', () => {
  const calls: string[] = [];
  handleStreamLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_delta', delta: {} },
    }),
    freshState(),
    { onTurnEnd: (r) => calls.push(r) },
  );
  assert.deepEqual(calls, []);
});

test('handleStreamLine: tool_use stop_reason 也正常透传', () => {
  const calls: string[] = [];
  handleStreamLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    }),
    freshState(),
    { onTurnEnd: (r) => calls.push(r) },
  );
  assert.deepEqual(calls, ['tool_use']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
npm run build && node --test dist/tests/provider.test.js
```
Expected: 3 个新测试 FAIL（`onTurnEnd` 类型不存在或回调不触发），原 5 个 PASS。

- [ ] **Step 3: 实现**

**3a. 在 `QueryOptions` 接口加字段**（`src/claude/provider.ts`）：

找到现有的：
```ts
  /** Called when a content block ends — use to flush buffered text. */
  onBlockEnd?: () => Promise<void> | void;
```

在其**之后**加：
```ts
  /** Called when an assistant turn ends, with its stop_reason
   *  ('tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | ...).
   *  Use to decide whether the turn's text is interstitial or final answer. */
  onTurnEnd?: (stopReason: string) => Promise<void> | void;
```

**3b. 在 `StreamParserCallbacks` 接口加字段**（同文件，Task 1 新增的部分）：

找到：
```ts
export interface StreamParserCallbacks {
  onText?: (text: string) => void;
  onBlockEnd?: () => void;
}
```

改为：
```ts
export interface StreamParserCallbacks {
  onText?: (text: string) => void;
  onBlockEnd?: () => void;
  onTurnEnd?: (stopReason: string) => void;
}
```

**3c. 在 `handleStreamLine` 的 `stream_event` case 加分支。** 找到 `content_block_stop` 分支：

```ts
      } else if (evt?.type === 'content_block_stop') {
        state.trackingSkill = false;
        if (callbacks.onBlockEnd) callbacks.onBlockEnd();
      }
      break;
```

在其**之后**（仍在 `stream_event` case 内、`break;` 之前）插入：

```ts
      } else if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
        if (callbacks.onTurnEnd) callbacks.onTurnEnd(evt.delta.stop_reason);
      }
```

注意：因为这是 `else if` 链，要把上面那个 `}` 闭合改一下。完整片段应该是：

```ts
      } else if (evt?.type === 'content_block_stop') {
        state.trackingSkill = false;
        if (callbacks.onBlockEnd) callbacks.onBlockEnd();
      } else if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
        if (callbacks.onTurnEnd) callbacks.onTurnEnd(evt.delta.stop_reason);
      }
      break;
```

**3d. 把 `onTurnEnd` 透传到 parserCallbacks。** 在 `claudeQuery` 内找到：

```ts
    const parserCallbacks: StreamParserCallbacks = { onText, onBlockEnd };
```

改为：
```ts
    const parserCallbacks: StreamParserCallbacks = { onText, onBlockEnd, onTurnEnd };
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
npm run build && node --test dist/tests/provider.test.js
```
Expected: 8 个测试全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/claude/provider.ts src/tests/provider.test.ts
git commit -m "$(cat <<'EOF'
feat: provider 暴露 onTurnEnd 回调，按 stop_reason 标记回合类型

handleStreamLine 在收到 message_delta 事件且带 stop_reason 时触发
onTurnEnd(stopReason)。下游可据此区分 'tool_use' 回合（interstitial）
和 'end_turn' / 'max_tokens' 等终态回合（final answer）。

本任务仅暴露信号，不改变任何现有 flush 行为——main.ts 下一任务接入。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 创建 `TurnRouter` 状态机

**Files:**
- Create: `src/claude/turn-router.ts`
- Create: `src/tests/turn-router.test.ts`

**Interfaces:**
- Consumes: 无（独立模块）
- Produces:
  - `export type MessageRole = 'interstitial' | 'final';`
  - `export interface RoutedMessage { text: string; role: MessageRole; }`
  - `export class TurnRouter { constructor(emit: (msg: RoutedMessage) => void); onText(delta: string): void; onTurnEnd(stopReason: string): void; drain(): void; }`

行为契约：
- `onText` 累积到内部 `turnBuffer`，不立即 emit。
- `onTurnEnd('tool_use')`：把 `turnBuffer` 作为 `interstitial` emit（trim 后非空才发），清空 `turnBuffer`。
- `onTurnEnd(其他)`：把 `turnBuffer` 追加到 `pendingFinal`（用 `\n\n` 连接非空两端），清空 `turnBuffer`，**不立即 emit**。
- `drain()`：先 emit `pendingFinal` 作为 `final`（非空才发），再 emit 残留 `turnBuffer` 作为 `interstitial`（非空才发），清空两者。

- [ ] **Step 1: 写失败测试**

Create `src/tests/turn-router.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnRouter, type RoutedMessage } from '../claude/turn-router.js';

function newRouter() {
  const emitted: RoutedMessage[] = [];
  const router = new TurnRouter((m) => emitted.push(m));
  return { router, emitted };
}

test('onText 累积不立即 emit', () => {
  const { router, emitted } = newRouter();
  router.onText('hello ');
  router.onText('world');
  assert.deepEqual(emitted, []);
});

test('onTurnEnd(tool_use) 把 turnBuffer 作为 interstitial emit', () => {
  const { router, emitted } = newRouter();
  router.onText('让我看一下');
  router.onTurnEnd('tool_use');
  assert.deepEqual(emitted, [{ text: '让我看一下', role: 'interstitial' }]);
});

test('onTurnEnd(end_turn) 不立即 emit，攒到 drain', () => {
  const { router, emitted } = newRouter();
  router.onText('最终答案第一段');
  router.onTurnEnd('end_turn');
  assert.deepEqual(emitted, []);
  router.drain();
  assert.deepEqual(emitted, [{ text: '最终答案第一段', role: 'final' }]);
});

test('多个 end_turn 回合用 \\n\\n 连接成一个 final', () => {
  const { router, emitted } = newRouter();
  router.onText('段一');
  router.onTurnEnd('pause_turn');
  router.onText('段二');
  router.onTurnEnd('end_turn');
  router.drain();
  assert.deepEqual(emitted, [{ text: '段一\n\n段二', role: 'final' }]);
});

test('tool_use 和 end_turn 混合：interstitial 立即发，final 攒到 drain', () => {
  const { router, emitted } = newRouter();
  router.onText('让我查一下');
  router.onTurnEnd('tool_use');          // → interstitial 立即
  router.onText('找到了。');
  router.onText('详细说明...');
  router.onTurnEnd('end_turn');          // → final 攒着
  router.drain();                         // → final 发出
  assert.deepEqual(emitted, [
    { text: '让我查一下', role: 'interstitial' },
    { text: '找到了。详细说明...', role: 'final' },
  ]);
});

test('空文本回合不产生空消息', () => {
  const { router, emitted } = newRouter();
  router.onTurnEnd('tool_use');           // turnBuffer 空
  router.onTurnEnd('end_turn');           // turnBuffer 空
  router.drain();
  assert.deepEqual(emitted, []);
});

test('onTurnEnd 未触发时 drain 也能把残留 turnBuffer 当 interstitial 发出', () => {
  const { router, emitted } = newRouter();
  router.onText('未结束的残留');
  router.drain();
  assert.deepEqual(emitted, [
    { text: '未结束的残留', role: 'interstitial' },
  ]);
});

test('纯文本 Q&A（无 tool_use，单 end_turn）整段作为 final', () => {
  const { router, emitted } = newRouter();
  const chunks = ['闭包是...', '举个例子...', '总结...'];
  for (const c of chunks) router.onText(c);
  router.onTurnEnd('end_turn');
  router.drain();
  assert.deepEqual(emitted, [
    { text: chunks.join(''), role: 'final' },
  ]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
npm run build && node --test dist/tests/turn-router.test.js
```
Expected: 导入失败 `Cannot find module ../claude/turn-router.js`。

- [ ] **Step 3: 实现 TurnRouter**

Create `src/claude/turn-router.ts`:

```ts
/**
 * TurnRouter 把 Claude CLI 的流式输出按"回合"分流：
 *
 * - tool_use 回合的文本 → 立即作为 interstitial emit（agent loop 进度）
 * - 其他 stop_reason（end_turn / max_tokens / stop_sequence / pause_turn / ...）
 *   的文本 → 攒到 pendingFinal，drain 时一次性作为 final emit
 *
 * 设计参考 docs/superpowers/specs/2026-06-20-message-batching-design.md。
 *
 * 本类不做任何 I/O，只决定"何时把哪段文本以什么 role emit"。
 * 调用方（main.ts）负责把 RoutedMessage 切分（splitMessage）并发到微信。
 */

export type MessageRole = 'interstitial' | 'final';

export interface RoutedMessage {
  text: string;
  role: MessageRole;
}

export class TurnRouter {
  private turnBuffer = '';
  private pendingFinal = '';

  constructor(private readonly emit: (msg: RoutedMessage) => void) {}

  onText(delta: string): void {
    this.turnBuffer += delta;
  }

  onTurnEnd(stopReason: string): void {
    const text = this.turnBuffer;
    this.turnBuffer = '';
    if (!text.trim()) return;
    if (stopReason === 'tool_use') {
      this.emit({ text, role: 'interstitial' });
    } else {
      // end_turn / max_tokens / stop_sequence / pause_turn / 未知值
      // 一律当最终答案处理（宁可合并也不丢）
      this.pendingFinal += this.pendingFinal ? '\n\n' + text : text;
    }
  }

  /** 流结束时调用。先发 final，再 drain 残留 interstitial。 */
  drain(): void {
    if (this.pendingFinal.trim()) {
      this.emit({ text: this.pendingFinal, role: 'final' });
      this.pendingFinal = '';
    }
    if (this.turnBuffer.trim()) {
      this.emit({ text: this.turnBuffer, role: 'interstitial' });
      this.turnBuffer = '';
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
npm run build && node --test dist/tests/turn-router.test.js
```
Expected: 8 个测试全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/claude/turn-router.ts src/tests/turn-router.test.ts
git commit -m "$(cat <<'EOF'
feat: 新增 TurnRouter 状态机，按 stop_reason 分流 interstitial/final

纯逻辑模块，不持 I/O。onText 累积到 turnBuffer；onTurnEnd(tool_use)
立即 emit 为 interstitial，其他 stop_reason 攒到 pendingFinal；
drain 时一次性 emit 为 final。

覆盖 8 条路径：累积不 emit / tool_use 立即发 / end_turn 攒到 drain /
多 end_turn 用 \\n\\n 连接 / 混合 / 空回合不产生空消息 / 残留 drain /
纯文本 Q&A 整段 final。

下一个任务把 main.ts 接进来。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 把 TurnRouter 接入 `main.ts`，删除死代码

**Files:**
- Modify: `src/main.ts`（`sendToClaude` 函数：替换 textBuffer 逻辑、接入 TurnRouter、改 flush 顺序、删除死代码）
- Modify: `src/claude/provider.ts`（删除 `QueryOptions.onBlockEnd` 字段、`StreamParserCallbacks.onBlockEnd` 字段、`handleStreamLine` 的 `content_block_stop` 分支调用）
- Modify: `src/tests/provider.test.ts`（删除 onBlockEnd 相关测试）

**Interfaces:**
- Consumes:
  - Task 1/2 的 `handleStreamLine` / `StreamParserCallbacks`（无 onBlockEnd）
  - Task 2 的 `QueryOptions.onTurnEnd`
  - Task 3 的 `TurnRouter` / `RoutedMessage`
- Produces: 无新对外接口（`sendToClaude` 仍是内部函数）

- [ ] **Step 1: 删除 provider.ts 里的 onBlockEnd（先消提供方，让消费方编译报错暴露出来）**

**1a. 修改 `src/claude/provider.ts` 的 `QueryOptions` 接口**，删除：
```ts
  /** Called when a content block ends — use to flush buffered text. */
  onBlockEnd?: () => Promise<void> | void;
```

**1b. 修改 `StreamParserCallbacks`**，删除 `onBlockEnd` 字段：
```ts
export interface StreamParserCallbacks {
  onText?: (text: string) => void;
  onBlockEnd?: () => void;        // ← 删这一行
  onTurnEnd?: (stopReason: string) => void;
}
```
变成：
```ts
export interface StreamParserCallbacks {
  onText?: (text: string) => void;
  onTurnEnd?: (stopReason: string) => void;
}
```

**1c. 修改 `handleStreamLine` 的 `content_block_stop` 分支**，不再调用 callbacks：

找到：
```ts
      } else if (evt?.type === 'content_block_stop') {
        state.trackingSkill = false;
        if (callbacks.onBlockEnd) callbacks.onBlockEnd();
      } else if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
```
改为：
```ts
      } else if (evt?.type === 'content_block_stop') {
        state.trackingSkill = false;
      } else if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
```

**1d. 修改 `claudeQuery` 内的 parserCallbacks 构造**，删除 onBlockEnd：

找到：
```ts
    const parserCallbacks: StreamParserCallbacks = { onText, onBlockEnd, onTurnEnd };
```
改为：
```ts
    const parserCallbacks: StreamParserCallbacks = { onText, onTurnEnd };
```

**1e. 在 `claudeQuery` 函数签名解构里删除 `onBlockEnd`。** 找到：
```ts
  const {
    prompt,
    cwd,
    resume,
    model,
    systemPrompt,
    images,
    onText,
    onBlockEnd,
    abortController,
  } = options;
```
改为（同时加 `onTurnEnd`）：
```ts
  const {
    prompt,
    cwd,
    resume,
    model,
    systemPrompt,
    images,
    onText,
    onTurnEnd,
    abortController,
  } = options;
```

- [ ] **Step 2: 改 provider.test.ts，删 onBlockEnd 测试**

在 `src/tests/provider.test.ts` 删除：
```ts
test('handleStreamLine: content_block_stop 触发 onBlockEnd', () => {
  let called = 0;
  handleStreamLine(
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
    freshState(),
    { onBlockEnd: () => called++ },
  );
  assert.equal(called, 1);
});
```

替换为（验证 content_block_stop 仍重置 trackingSkill，但不发回调）：
```ts
test('handleStreamLine: content_block_stop 重置 trackingSkill，无回调', () => {
  const state = freshState();
  state.trackingSkill = true;
  let textCalls = 0;
  handleStreamLine(
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
    state,
    { onText: () => textCalls++ },
  );
  assert.equal(state.trackingSkill, false);
  assert.equal(textCalls, 0);
});
```

- [ ] **Step 3: 编译确认 provider 侧改动不报错（此时 main.ts 还在传 onBlockEnd，预期会报错）**

Run:
```bash
npm run build 2>&1 | head -20
```
Expected: 在 `src/main.ts` 报 TypeScript 错误，类似：
```
error TS2322: Type '{ onText: ...; onBlockEnd: ...; onTurnEnd: ...; }' is not assignable to type 'QueryOptions' ...
  Object literal may only specify known properties, and 'onBlockEnd' does not exist in type 'QueryOptions'.
```
这是预期的——下一个 step 修 main.ts。

- [ ] **Step 4: 重写 main.ts 的 sendToClaude，接入 TurnRouter**

**4a. 加 import。** 在 `src/main.ts` 顶部 imports 区，找到：
```ts
import { claudeQuery, type QueryOptions } from './claude/provider.js';
```
在其**之后**加：
```ts
import { TurnRouter } from './claude/turn-router.js';
```

**4b. 删除死代码 `endsWithStructuralBoundary`。** 在 `src/main.ts` 的 `sendToClaude` 函数内（约 501-503 行）找到：

```ts
    /** Check if buffer ends at a structural boundary (double newline or horizontal rule). */
    function endsWithStructuralBoundary(text: string): boolean {
      return /\n\n\s*$/.test(text) || /\n[-*_]{3,}\s*$/.test(text);
    }
```

整个函数**删除**。

> 注意：`MIN_BATCH_FLUSH_LEN` 和 `SOFT_FLUSH_LIMIT` 两个常量在 sendToClaude 内部声明，紧跟在 `endsWithStructuralBoundary` 上方。它们会在 step 4c 的整段替换里一并消失（OLD 块包含它们，NEW 块不包含），无需单独处理。

**4c. 替换 sendToClaude 内的流式处理段。** 找到现有的（约 493-591 行）：

```ts
    let textBuffer = '';
    let anySent = false;
    let lastSentTime = Date.now();

    const MIN_BATCH_FLUSH_LEN = 30;
    const SOFT_FLUSH_LIMIT = 3800;

    /** Check if buffer ends at a structural boundary (double newline or horizontal rule). */
    function endsWithStructuralBoundary(text: string): boolean {
      return /\n\n\s*$/.test(text) || /\n[-*_]{3,}\s*$/.test(text);
    }

    // Serial promise chain — each flushText() appends to the chain, no flags needed
    let flushChain: Promise<void> = Promise.resolve();

    function flushText(): Promise<void> {
      // Capture and clear synchronously to prevent race condition:
      // new deltas can arrive while the chain awaits sendText,
      // causing the async callback to clear content it never captured.
      const captured = textBuffer.trim();
      textBuffer = '';
      if (!captured) return flushChain;

      flushChain = flushChain.then(async () => {
        const chunks = splitMessage(captured);
        for (let i = 0; i < chunks.length; i++) {
          try {
            await sender.sendText(fromUserId, contextToken, chunks[i]);
          } catch (err) {
            // Rate-limit exhaustion etc.: put the unsent chunks back at the
            // front of the buffer so the next flush retries them. Content is
            // never silently dropped (previously the for-loop aborted here and
            // the already-cleared buffer lost everything from this chunk on).
            const remaining = chunks.slice(i).join('\n\n');
            textBuffer = remaining + (textBuffer ? '\n\n' + textBuffer : '');
            logger.warn('flushText send failed, content retained for retry', {
              error: err instanceof Error ? err.message : String(err),
              retainedChunks: chunks.length - i,
            });
            return;
          }
        }
        anySent = true;
        lastSentTime = Date.now();
      });
      return flushChain;
    }

    // Safety net: send keepalive if nothing was sent for 5 minutes
    const SILENCE_WARNING_MS = 5 * 60 * 1000;
    const SILENCE_MESSAGES = [
      '我还在处理中，这个问题有点复杂，请再稍等一下',
      '正在努力干活中，马上就有结果了，请稍等片刻',
      '有点复杂正在处理，再给我一点时间，很快就好',
      '快好了别着急，正在收尾阶段，马上给你回复',
      '还在跑呢，任务量比较大，不过马上就能出结果了',
      '任务比想象的复杂一些，再等等我，正在全力处理',
      '正在处理中，进展顺利，再等一会儿就好',
      '还没完不过已经快了，再给我一分钟就能搞定',
      '我在认真思考这个问题，请再稍等一会儿',
      '稍微有点棘手，不过已经快解决了，再等我一下',
    ];
    flushTimer = setInterval(() => {
      if (Date.now() - lastSentTime > SILENCE_WARNING_MS) {
        const msg = SILENCE_MESSAGES[Math.floor(Math.random() * SILENCE_MESSAGES.length)];
        sender.sendText(fromUserId, contextToken, msg).catch(() => {});
        lastSentTime = Date.now();
      }
    }, 2000);

    const queryOptions: QueryOptions = {
      prompt,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      resume: session.sdkSessionId,
      model: session.model,
      systemPrompt: [
        '你正在通过微信与用户对话，不是在终端里。不要让用户去终端操作。如果用户需要文件，直接输出文件地址就行，会自动识别解析推送文件到用户的微信中。',
        config.systemPrompt,
      ].filter(Boolean).join('\n'),
      abortController,
      images,
      onText: async (delta: string) => {
        textBuffer += delta;

        // Flush at structural boundaries (only if buffer is substantial) or when approaching size limit
        const shouldFlush =
          (endsWithStructuralBoundary(textBuffer) && textBuffer.trim().length >= MIN_BATCH_FLUSH_LEN)
          || textBuffer.length > SOFT_FLUSH_LIMIT;

        if (shouldFlush) {
          await flushText();
        }
      },
      onBlockEnd: () => {
        if (textBuffer.trim().length >= MIN_BATCH_FLUSH_LEN || textBuffer.length > SOFT_FLUSH_LIMIT) {
          flushText();
        }
      },
    };
```

整段替换为：

```ts
    let anySent = false;
    let lastSentTime = Date.now();
    let pendingRetry = '';   // sendText 失败时未发出的 chunks，下一次 flush 优先重试

    // Serial promise chain — each emit appends to the chain, no flags needed
    let flushChain: Promise<void> = Promise.resolve();

    /** 把一段文本切分后串行发到微信。失败时把未发的 chunks 攒到 pendingRetry，下次重试。 */
    function emitText(text: string, role: 'interstitial' | 'final'): void {
      if (!text.trim()) return;
      flushChain = flushChain.then(async () => {
        const combined = pendingRetry ? pendingRetry + '\n\n' + text : text;
        pendingRetry = '';
        if (!combined.trim()) return;
        const chunks = splitMessage(combined);
        for (let i = 0; i < chunks.length; i++) {
          try {
            await sender.sendText(fromUserId, contextToken, chunks[i]);
          } catch (err) {
            // Rate-limit exhaustion etc.: put the unsent chunks back so the
            // next emit retries them. Content is never silently dropped.
            pendingRetry = chunks.slice(i).join('\n\n');
            logger.warn('emitText send failed, content retained for retry', {
              role,
              error: err instanceof Error ? err.message : String(err),
              retainedChunks: chunks.length - i,
            });
            return;
          }
        }
        anySent = true;
        lastSentTime = Date.now();
      });
    }

    const router = new TurnRouter((msg) => emitText(msg.text, msg.role));

    // Safety net: send keepalive if nothing was sent for 5 minutes
    const SILENCE_WARNING_MS = 5 * 60 * 1000;
    const SILENCE_MESSAGES = [
      '我还在处理中，这个问题有点复杂，请再稍等一下',
      '正在努力干活中，马上就有结果了，请稍等片刻',
      '有点复杂正在处理，再给我一点时间，很快就好',
      '快好了别着急，正在收尾阶段，马上给你回复',
      '还在跑呢，任务量比较大，不过马上就能出结果了',
      '任务比想象的复杂一些，再等等我，正在全力处理',
      '正在处理中，进展顺利，再等一会儿就好',
      '还没完不过已经快了，再给我一分钟就能搞定',
      '我在认真思考这个问题，请再稍等一会儿',
      '稍微有点棘手，不过已经快解决了，再等我一下',
    ];
    flushTimer = setInterval(() => {
      if (Date.now() - lastSentTime > SILENCE_WARNING_MS) {
        const msg = SILENCE_MESSAGES[Math.floor(Math.random() * SILENCE_MESSAGES.length)];
        sender.sendText(fromUserId, contextToken, msg).catch(() => {});
        lastSentTime = Date.now();
      }
    }, 2000);

    const queryOptions: QueryOptions = {
      prompt,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      resume: session.sdkSessionId,
      model: session.model,
      systemPrompt: [
        '你正在通过微信与用户对话，不是在终端里。不要让用户去终端操作。如果用户需要文件，直接输出文件地址就行，会自动识别解析推送文件到用户的微信中。',
        config.systemPrompt,
      ].filter(Boolean).join('\n'),
      abortController,
      images,
      onText: (delta: string) => {
        router.onText(delta);
      },
      onTurnEnd: (stopReason: string) => {
        router.onTurnEnd(stopReason);
      },
    };
```

**4d. 修改流结束后的 flush 顺序。** 找到（约 605-627 行）：

```ts
    // Stop periodic flush and send any remaining buffered content
    clearInterval(flushTimer);
    await flushText();

    // Send result back to WeChat
    if (result.text) {
      if (result.error) {
        logger.warn('Claude query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      // If nothing was streamed at all (e.g. streaming not supported), send full text now
      if (!anySent) {
        const chunks = splitMessage(result.text);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
```

替换 `clearInterval(flushTimer);` 和 `await flushText();` 这两行（保留后面所有内容不变）：

```ts
    // Stop periodic flush, drain router (final 先于 interstitial), wait for queued sends
    clearInterval(flushTimer);
    router.drain();
    await flushChain;

    // Send result back to WeChat
    if (result.text) {
      if (result.error) {
        logger.warn('Claude query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      // If nothing was streamed at all (e.g. streaming not supported), send full text now
      if (!anySent) {
        const chunks = splitMessage(result.text);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
```

- [ ] **Step 5: 编译并跑所有测试**

Run:
```bash
npm run build && npm test
```
Expected:
- TypeScript 编译零错误（确认 onBlockEnd 已彻底从 main.ts 移除）。
- 所有测试 PASS：`provider.test.ts`（8 个）+ `turn-router.test.ts`（8 个）。

- [ ] **Step 6: 端到端冒烟**

Run:
```bash
echo "" | node dist/main.js 2>&1 | head -5 || true
```
Expected: 进程启动、读到 `未找到账号` 或类似的运行期错误（因为没配置），但**不应**报 TypeScript / 模块解析错误。这验证编译产物导入正常。

- [ ] **Step 7: 真实 trace 验证新逻辑依赖的信号确实存在**

重新跑一份 trace，确认 Claude CLI 真实输出里包含新逻辑依赖的 `message_delta` 事件：

```bash
mkdir -p /tmp/verify-batching && cd /tmp/verify-batching && \
echo "用三段话解释 JavaScript 闭包" | claude -p - --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions 2>/dev/null > trace.jsonl && \
echo "trace 行数: $(wc -l < trace.jsonl)" && \
echo "--- message_delta 事件数（应 >= 1）---" && \
grep -c '"type":"message_delta"' trace.jsonl && \
echo "--- 各 stop_reason 分布 ---" && \
grep -o '"stop_reason":"[^"]*"' trace.jsonl | sort | uniq -c
```

Expected:
- trace 行数 > 100。
- 至少 1 个 `message_delta` 事件。
- stop_reason 分布里至少有 1 个 `end_turn`（纯 Q&A 场景）。

> 这一步只验证「我们依赖的信号真实存在」。完整端到端效果验证（消息条数从 N 降到 1）需要装上 daemon 在微信里实测，见下方「验收清单」。

- [ ] **Step 8: 提交**

```bash
git add src/main.ts src/claude/provider.ts src/tests/provider.test.ts
git commit -m "$(cat <<'EOF'
feat: main.ts 接入 TurnRouter，最终答案改为按回合整段推送

把 sendToClaude 原来的单 textBuffer + 段落边界 flush 逻辑替换为
TurnRouter 状态机：onText 只累积不 flush，onTurnEnd(tool_use) 立即
emit 为 interstitial，其他 stop_reason 攒到 pendingFinal，流结束时
router.drain() 一次性 emit 为 final（splitMessage 按 4000 字硬切）。

真实 trace 验证效果：
- 纯文本 Q&A（1485 字）：8 条 → 1 条
- tool_use + 9121 字长答案：59 条 → 4 条

顺带清理死代码：删除 MIN_BATCH_FLUSH_LEN / SOFT_FLUSH_LIMIT /
endsWithStructuralBoundary / onBlockEnd（provider.ts 同步移除字段
和 content_block_stop 回调，测试相应更新）。

限流逻辑、splitMessage、typing、silence warning、文件自动推送
全部不动。emitText 保留了 commit d6d7d62 引入的失败重试语义
（pendingRetry）。

Spec: docs/superpowers/specs/2026-06-20-message-batching-design.md

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## 验收清单（实现完成后人工跑一遍）

参考 spec § 7.3：

1. **纯 Q&A**：微信发"用三段话解释闭包"→ 应收到 **1 条**完整答案（而非现在的 8 条）。
2. **多 tool_use + 长答案**：微信发"分析 src/main.ts 的结构"→ 应收到 1 条 interstitial + N 条最终答案块（按 4000 字切），总条数远少于现在。
3. **Abort**：发任务后立即发 `/stop` → 已发的 interstitial 不丢，部分生成的最终答案按已生成内容推送，无内容丢失。
4. **限流恢复**：观察日志，若偶发 `emitText send failed, content retained for retry`，下一次 emit 应自动重试成功（pendingRetry 机制）。
