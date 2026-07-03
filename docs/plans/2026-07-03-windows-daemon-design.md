# Windows Daemon Design

Make the existing daemon command usable on Windows without keeping the launching PowerShell window occupied.

## Approach

Add a Node-based daemon manager and point `npm run daemon` at it. On Windows, the manager starts `dist/main.js start` as a detached background process, writes a PID file under the existing data directory, and redirects stdout/stderr to log files. On macOS and Linux, it delegates to the existing `scripts/daemon.sh` so the current launchd/systemd behavior remains intact.

## Commands

- `npm run daemon -- start` starts the bridge in the background.
- `npm run daemon -- stop` stops the PID recorded by the manager.
- `npm run daemon -- restart` stops then starts.
- `npm run daemon -- status` reports whether the PID is alive.
- `npm run daemon -- logs` prints recent bridge/stdout/stderr logs.

## Data

The manager keeps using the current compatibility data directory, `~/.wechat-claude-code`, unless `WCC_DATA_DIR` is set. It writes:

- `wechat-ai-coder.pid`
- `logs/stdout.log`
- `logs/stderr.log`

## Testing

Unit tests cover path construction, Windows spawn configuration, and stale PID status handling. Manual verification covers build, tests, and command help/status behavior.
