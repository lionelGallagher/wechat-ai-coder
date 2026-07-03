# WeChat AI Coder

<p align="center">
  <strong>在微信里调用你电脑上的本地编程 Agent</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="README_en.md"><img src="https://img.shields.io/badge/Lang-English-lightgrey?style=flat-square" alt="English"></a>
</p>

WeChat AI Coder 是一个把个人微信和本地编程 Agent 连接起来的桥接服务。扫码绑定微信后，你可以像给朋友发消息一样，把需求、文件、图片或语音发到微信里，由电脑上的本地 Agent 处理，再把结果实时推送回微信。

这个仓库由 `wechat-claude-code` 改造而来。当前可用能力仍以 Claude Code CLI 为主；接下来会改造成 Codex 默认、Claude Code 可选的多 provider 架构。

## 目标能力

| 能力 | 说明 |
|---|---|
| 微信远程编程 | 在手机微信里给本地 Agent 发任务，不需要远程桌面。 |
| Codex 默认 | 默认调用本地 `codex` CLI，使用 `danger-full-access` 执行本地开发任务。 |
| Claude 可选 | 保留 Claude Code CLI 作为可切换 provider。 |
| 多模型切换 | 使用微信命令切换当前 provider 下的模型。 |
| 文件双向传递 | 微信发来的图片、文档会下载到本地；Agent 生成的文件可自动推送回微信。 |
| 消息降噪 | 过滤工具调用和中间过程，只把关键进度和最终结果发回微信。 |
| 本地运行 | 微信凭证、会话、日志都保存在本机，不需要部署服务器。 |

## 当前状态

当前代码仍是 Claude Code 单 provider 版本：

- 微信绑定、消息轮询、文件收发、会话状态已经可用。
- `/model` 当前切换的是 Claude Code 模型。
- Codex 默认、`/provider codex|claude`、provider 独立会话 ID 还在改造计划中。

如果你现在运行本项目，需要先安装并登录 Claude Code CLI。Codex 支持落地后，默认前置依赖会改为 Codex CLI。

## 安装

```bash
git clone https://github.com/lionelGallagher/wechat-ai-coder.git ~/.claude/skills/wechat-ai-coder
cd ~/.claude/skills/wechat-ai-coder
npm install
```

## 快速开始

### 1. 扫码绑定微信

```bash
npm run setup
```

执行后会弹出二维码，用个人微信扫码完成绑定。

### 2. 启动服务

```bash
npm run daemon -- start
```

macOS 下会通过 `launchd` 管理守护进程，支持开机自启和崩溃重启。Linux 可直接运行 Node 入口或按需接入自己的进程管理工具。

### 3. 在微信里发送任务

打开微信，给绑定出来的联系人发送文字、语音、图片或文件。服务会把消息转发给本地 CLI，并把回复推送回微信。

## 服务管理

```bash
npm run daemon -- status   # 查看运行状态
npm run daemon -- stop     # 停止服务
npm run daemon -- restart  # 重启服务
npm run daemon -- logs     # 查看日志
```

## 微信命令

| 命令 | 当前说明 |
|---|---|
| `/help` | 显示帮助 |
| `/clear` | 清除当前会话，开始新对话 |
| `/stop` | 停止当前任务 |
| `/model <名称>` | 切换当前 CLI 模型，目前作用于 Claude Code |
| `/prompt <内容>` | 设置系统提示词 |
| `/cwd <路径>` | 切换工作目录 |
| `/skills` | 查看已安装的 Skill |
| `/status` | 查看当前会话状态 |
| `/history [数量]` | 查看最近对话记录 |
| `/compact` | 压缩上下文，开始新 CLI 会话 |
| `/reset` | 完全重置会话设置 |
| `/undo [数量]` | 撤销最近几条对话 |
| `/<skill> [参数]` | 触发任意已安装的 Skill |

计划新增：

```text
/provider codex    切换到 Codex
/provider claude   切换到 Claude Code
```

## 工作原理

```text
微信（手机） <-> ilink Bot API <-> Node.js 守护进程 <-> 本地编程 Agent CLI
```

守护进程通过长轮询监听微信消息，把用户输入、图片和文件转交给本地 CLI。CLI 输出会被解析、分段、过滤噪音后发送回微信。

## Codex 改造计划

第一阶段会把现有 Claude 专用调用抽象为 provider 接口：

- 默认 provider 改为 `codex`。
- Codex 调用使用 `codex exec --json --cd <cwd> --sandbox danger-full-access`。
- 有模型配置时追加 `--model <model>`。
- Claude Code 作为 `claude` provider 保留。
- 会话数据保存 provider 信息，避免 Codex 和 Claude 的 session ID 混用。
- `/status` 显示当前 provider、模型、工作目录和会话 ID。

## 前置条件

当前版本：

- Node.js >= 18
- macOS 或 Linux
- 个人微信账号
- Claude Code CLI 已安装并完成登录

Codex 改造完成后：

- Codex CLI 已安装并完成登录
- 默认执行权限为 `danger-full-access`

## 数据目录

默认数据存储在 `~/.wechat-claude-code/`：

```text
~/.wechat-claude-code/
├── accounts/       # 微信账号凭证
├── config.json     # 全局配置
├── sessions/       # 会话数据
└── logs/           # 运行日志
```

后续可能迁移到 `~/.wechat-ai-coder/`。为了兼容旧数据，迁移会单独处理。

## License

[MIT](LICENSE)
