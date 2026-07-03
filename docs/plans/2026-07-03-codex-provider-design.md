# Codex Provider Design

## Goal

Make WeChat AI Coder use the local Codex CLI as the default end-to-end agent after WeChat binding, while keeping Claude Code CLI available as an optional provider.

## Requirements

- WeChat QR binding continues to use the existing iLink/OpenClaw bridge endpoint.
- Default local task execution uses `codex exec --json`.
- `/provider codex|claude` switches the current provider.
- Default execution runs in the selected working directory with `--sandbox danger-full-access`.
- Non-interactive approval behavior is set through Codex config override because this Codex CLI version does not expose `--ask-for-approval` on `codex exec`.
- The bridge stores Codex thread IDs and Claude session IDs separately and resumes the active provider only.
- Image attachments are passed via `--image`.
- WeChat commands and status text show the active provider.
- Existing message routing, file auto-push, pending queue, and iLink account storage keep working.

## Architecture

Add provider dispatch around the existing message handling. Codex remains the default provider and parses Codex JSONL events: `thread.started` supplies the session ID, `item.completed` with `agent_message` supplies assistant text, `turn.completed` ends the final answer, `turn.failed` and `error` surface failures. Claude remains available through its stream-json parser. Main message handling continues to use `TurnRouter`, but dispatches to the active provider and stores IDs in `session.providerSessionIds`.

The first request runs:

```bash
codex exec --json --cd <cwd> --sandbox danger-full-access -c 'approval_policy="never"' -
```

Follow-up requests with a saved thread ID run:

```bash
codex exec resume --json -c 'approval_policy="never"' -c 'sandbox_mode="danger-full-access"' <thread-id> -
```

`--model <name>` and repeated `--image <path>` are added when present.

## Implementation Plan

1. Add failing provider parser and argument-construction tests.
2. Implement Codex JSONL parsing and command argument construction.
3. Rename the public query surface from Claude-specific to agent/Codex-specific.
4. Add provider state, `/provider`, and provider-specific session IDs.
5. Keep Claude Code as an optional provider.
6. Update command replies, status/version text, and user-facing errors.
7. Update README/SKILL text to describe Codex as the default and Claude as optional.
8. Run build, tests, and a read-only real `codex exec --json` smoke check.
