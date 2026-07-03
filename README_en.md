# WeChat AI Coder

**Default local agent: Codex CLI. Optional local agent: Claude Code CLI.**

Bridge personal WeChat messages to local coding agents. Codex CLI is the default provider, and Claude Code CLI is available as an optional provider. After binding WeChat with a QR code, you can send text, images, files, or voice messages in WeChat; the daemon forwards them to the selected local provider and sends the result back to WeChat.

> The WeChat QR confirmation screen may show the iLink/OpenClaw app name. That is the WeChat transport layer, not the local agent. The local execution layer is Codex by default, or Claude after `/provider claude`.

## Provider Support

| Provider | Status | How to use |
|---|---|---|
| Codex CLI | Default | No switch needed. New sessions use Codex unless changed. |
| Claude Code CLI | Optional | Run `/provider claude` after Claude Code CLI is installed and authenticated. |

Switch providers from WeChat:

```text
/provider codex
/provider claude
/status
```

Codex and Claude keep separate session IDs, so switching providers does not mix their conversation state.

## Highlights

| | |
|---|---|
| **WeChat remote coding** | Send coding tasks from your phone without remote desktop access. |
| **Codex by default** | Runs local tasks with `codex exec --json --sandbox danger-full-access`. |
| **Claude optional** | Switch with `/provider claude` when Claude Code CLI is installed. |
| **Independent sessions** | Stores separate Codex thread IDs and Claude session IDs, so providers do not share conversation state. |
| **Two-way files** | WeChat attachments are downloaded locally; generated file paths can be pushed back to WeChat. |
| **Cleaner messages** | Tool noise is filtered before messages are sent back to WeChat. |
| **Local-first** | WeChat credentials, sessions, and logs stay on your machine. |

## Install

```bash
git clone https://github.com/lionelGallagher/wechat-ai-coder.git ~/.codex/skills/wechat-ai-coder
cd ~/.codex/skills/wechat-ai-coder
npm install
```

## Quick Start

### 1. Install and authenticate Codex CLI

```bash
codex login
codex doctor
```

Claude is optional:

```bash
claude --version
```

### 2. Bind WeChat

```bash
npm run setup
```

A QR code will pop up. Scan it with personal WeChat. If WeChat says it will link `openclaw`, that is the iLink transport app name.

### 3. Start the service

```bash
npm run daemon -- start
```

On Windows this starts the service in the background and releases the current PowerShell window. macOS uses `launchd`; Linux uses a systemd user service when available and falls back to a direct background process.

To keep the service in the foreground for live output, use:

```bash
npm start
```

### 4. Start chatting

Open WeChat and send a message to the bound contact. The daemon forwards the message to the selected local provider and streams the reply back.

## Service Management

```bash
npm run daemon -- status
npm run daemon -- stop
npm run daemon -- restart
npm run daemon -- logs
```

On Windows, the PID file and stdout/stderr logs are written under `~/.wechat-claude-code/`.

## Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` | Clear current session |
| `/stop` | Stop current task |
| `/provider [codex|claude]` | View or switch the current provider |
| `/model <name>` | Switch the current provider model, for example `/model gpt-5.5` |
| `/prompt <text>` | Set a system prompt |
| `/cwd <path>` | Switch working directory |
| `/skills` | List installed Skills |
| `/status` | Show provider, model, working directory, and current provider session ID |
| `/history [n]` | View recent chat history |
| `/compact` | Clear the current provider session ID and start a fresh session next turn |
| `/reset` | Reset session settings |
| `/undo [n]` | Remove recent messages from history |
| `/<skill> [args]` | Trigger an installed Skill |

## How It Works

```text
WeChat phone <-> iLink/OpenClaw Bot API <-> Node.js daemon <-> Codex or Claude CLI local
```

Codex first turns run:

```bash
codex exec --json --cd <cwd> --sandbox danger-full-access -c 'approval_policy="never"' -
```

Codex resumed turns run:

```bash
codex exec resume --json -c 'approval_policy="never"' -c 'sandbox_mode="danger-full-access"' <thread-id> -
```

## Prerequisites

- Node.js >= 18
- Windows, macOS, or Linux
- Personal WeChat account
- Codex CLI installed and authenticated
- Claude Code CLI installed and authenticated, only if you use `/provider claude`

## Data Directory

For compatibility with existing bindings, data is still stored in `~/.wechat-claude-code/`:

```text
~/.wechat-claude-code/
|-- accounts/
|-- config.json
|-- sessions/
|-- pending/
`-- logs/
```

## License

[MIT](LICENSE)
