# Windows Daemon Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Windows-friendly background daemon manager so `npm run daemon -- start` does not occupy the current console.

**Architecture:** Add `src/daemon.ts` as the npm daemon entrypoint. It implements direct detached process management on Windows and delegates to the existing Bash manager on macOS/Linux.

**Tech Stack:** Node.js child_process/fs/path APIs, TypeScript, Node test runner.

---

### Task 1: Daemon Helper Tests

**Files:**
- Create: `src/tests/daemon.test.ts`

**Step 1: Write the failing test**

Add tests for:
- daemon path construction under a supplied data directory
- Windows detached spawn config
- stale PID status when no PID file exists

**Step 2: Run test to verify it fails**

Run: `npm run build`

Expected: TypeScript fails because `src/daemon.ts` does not exist yet.

### Task 2: Daemon Manager

**Files:**
- Create: `src/daemon.ts`
- Modify: `package.json`

**Step 1: Write minimal implementation**

Implement exported helper functions for tests and CLI commands for `start`, `stop`, `restart`, `status`, and `logs`.

**Step 2: Run tests**

Run: `npm run build && npm test`

Expected: build succeeds and all Node tests pass.

### Task 3: Docs

**Files:**
- Modify: `README.md`
- Modify: `README_en.md`

**Step 1: Update startup docs**

Document that `npm run daemon -- start` now works on Windows in the background, while `npm start` remains foreground mode.

**Step 2: Verify**

Run: `npm run build && npm test`

Expected: build succeeds and all tests pass.
