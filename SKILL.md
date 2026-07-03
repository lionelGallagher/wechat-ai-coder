---
name: wechat-ai-coder
description: 微信消息桥接 - 在微信中与本地 Codex CLI 或 Claude Code CLI 聊天。支持文字对话、图片识别、实时进度推送、文件收发和斜杠命令。
---

# WeChat AI Coder

通过个人微信与本机编程 Agent 对话。默认 provider 是 Codex CLI，也可以用 `/provider claude` 切换到 Claude Code CLI。

## 前置条件

- Node.js >= 18
- Windows、macOS 或 Linux
- 个人微信账号，需要扫码绑定
- Codex CLI 已安装并完成登录
- Claude Code CLI 可选，仅在使用 `/provider claude` 时需要

## 安装

```bash
git clone https://github.com/lionelGallagher/wechat-ai-coder.git ~/.codex/skills/wechat-ai-coder
cd ~/.codex/skills/wechat-ai-coder
npm install
```

## 触发场景

用户提到“微信桥接”、“微信聊天”、“wechat bridge”、“连接微信”、“微信状态”、“停止微信”等与微信桥接相关的话题时触发。

## 状态检查流程

先检查项目、依赖、微信绑定和 daemon 状态，再给出可用操作。

### 1. 检查项目

```bash
test -f ~/.codex/skills/wechat-ai-coder/package.json && echo "source_ok" || echo "source_missing"
```

### 2. 检查依赖

```bash
cd ~/.codex/skills/wechat-ai-coder && test -d node_modules && echo "deps_ok" || echo "deps_missing"
```

如果 `deps_missing`，执行：

```bash
cd ~/.codex/skills/wechat-ai-coder && npm install
```

### 3. 检查微信绑定

```bash
ls ~/.wechat-claude-code/accounts/*.json 2>/dev/null | head -1
```

数据目录仍沿用 `~/.wechat-claude-code/`，用于兼容旧绑定。

### 4. 检查 daemon

```bash
cd ~/.codex/skills/wechat-ai-coder && npm run daemon -- status
```

## 子命令

所有命令的工作目录为 `~/.codex/skills/wechat-ai-coder`。

| 命令 | 执行 | 说明 |
|---|---|---|
| setup | `npm run setup` | 首次安装向导：生成 QR 码，微信扫码，配置工作目录 |
| start | `npm run daemon -- start` | 启动守护进程 |
| stop | `npm run daemon -- stop` | 停止守护进程 |
| restart | `npm run daemon -- restart` | 重启守护进程 |
| status | `npm run daemon -- status` | 查看运行状态 |
| logs | `npm run daemon -- logs` | 查看最近日志 |

## 微信端命令

```text
/help
/clear
/stop
/status
/provider codex
/provider claude
/model gpt-5.5
/prompt 用中文回复我
/cwd <path>
/skills
/history
/compact
```
