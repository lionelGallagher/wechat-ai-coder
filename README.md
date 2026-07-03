# WeChat AI Coder

把个人微信消息桥接到本机编程 Agent。默认 provider 是 Codex CLI，也可以用 `/provider claude` 切换到 Claude Code CLI。扫码绑定微信后，你可以在微信里发送需求、图片、文件或语音，守护进程会把消息转交给当前 provider，再把结果推回微信。

> 微信扫码页显示的应用名来自 iLink/OpenClaw 微信通道；这不代表本地执行层使用 OpenClaw。本项目的本地 Agent 默认是 Codex CLI，也支持切换到 Claude Code CLI。

## 能力

| 能力 | 说明 |
|---|---|
| 微信远程编程 | 在手机微信里给本机 Codex 发任务，不需要远程桌面。 |
| Codex 默认 | 使用 `codex exec --json --sandbox danger-full-access` 执行本地开发任务。 |
| Claude 可选 | 使用 `/provider claude` 切换到 Claude Code CLI。 |
| 独立会话 | Codex thread ID 和 Claude session ID 分开保存，避免上下文串用。 |
| 文件双向传递 | 微信图片、文档会下载到本地；Codex 生成的文件路径会被识别并推送回微信。 |
| 消息降噪 | 过滤工具调用噪音，只把关键进度和最终结果发回微信。 |
| 本地运行 | 微信凭证、会话、日志都保存在本机。 |

## 安装

```bash
git clone https://github.com/lionelGallagher/wechat-ai-coder.git ~/.codex/skills/wechat-ai-coder
cd ~/.codex/skills/wechat-ai-coder
npm install
```

## 快速开始

### 1. 安装并登录 Codex CLI

```bash
codex login
codex doctor
```

Claude 是可选 provider：

```bash
claude --version
```

### 2. 扫码绑定微信

```bash
npm run setup
```

执行后会弹出二维码，用个人微信扫码完成绑定。扫码页如果显示 `openclaw`，这是微信/iLink 通道名称，不影响本地 Codex 执行。

### 3. 启动服务

```bash
npm run daemon -- start
```

Windows 下该命令会在后台启动服务，不会占用当前 PowerShell 窗口。macOS 会通过 `launchd` 管理守护进程；Linux 会优先使用 systemd user service，不可用时退回直接后台进程。

`npm start` 等同于后台启动：

```bash
npm start
```

如果希望以前台进程运行，方便看实时输出，可以使用：

```bash
npm run foreground
```

### 4. 在微信里发送任务

打开微信，给绑定出来的联系人发送文字、语音、图片或文件。服务会把消息转发给当前 provider，并把回复推送回微信。

## 服务管理

```bash
npm run daemon -- status
npm run daemon -- stop
npm run daemon -- restart
npm run daemon -- logs
```

Windows 后台进程的 PID 和 stdout/stderr 日志会写入 `~/.wechat-claude-code/`。

## 微信命令

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助 |
| `/clear` | 清除当前会话，开始新对话 |
| `/stop` | 停止当前任务 |
| `/provider [codex|claude]` | 查看或切换当前 provider |
| `/model <名称>` | 切换当前 provider 的模型，例如 `/model gpt-5.5` |
| `/prompt <内容>` | 设置系统提示词 |
| `/cwd <路径>` | 切换工作目录 |
| `/skills` | 查看已安装的 Skill |
| `/status` | 查看 Provider、模型、工作目录和当前 provider 的会话 ID |
| `/history [数量]` | 查看最近对话记录 |
| `/compact` | 清除当前 provider 的会话 ID，下次消息开始新会话 |
| `/reset` | 完全重置会话设置 |
| `/undo [数量]` | 撤销最近几条对话 |
| `/<skill> [参数]` | 触发任意已安装的 Skill |

## 工作原理

```text
微信（手机） <-> iLink/OpenClaw Bot API <-> Node.js 守护进程 <-> Codex 或 Claude CLI（本机）
```

守护进程通过长轮询监听微信消息，把用户输入、图片和文件转交给当前 provider。Codex 首轮请求使用：

```bash
codex exec --json --cd <cwd> --sandbox danger-full-access -c 'approval_policy="never"' -
```

Codex 有 thread ID 时使用：

```bash
codex exec resume --json -c 'approval_policy="never"' -c 'sandbox_mode="danger-full-access"' <thread-id> -
```

## 前置条件

- Node.js >= 18
- Windows、macOS 或 Linux
- 个人微信账号
- Codex CLI 已安装并完成登录
- Claude Code CLI 已安装并完成登录，仅在使用 `/provider claude` 时需要

## 数据目录

默认仍使用旧目录 `~/.wechat-claude-code/` 以兼容已经绑定的微信账号：

```text
~/.wechat-claude-code/
|-- accounts/       # 微信账号凭证
|-- config.json     # 全局配置
|-- sessions/       # 会话数据
|-- pending/        # 待补发消息
`-- logs/           # 运行日志
```

后续如迁移到 `~/.wechat-ai-coder/`，会单独处理兼容。

## License

[MIT](LICENSE)
