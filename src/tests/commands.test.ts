import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCompact, handleModel, handleProvider, handleStatus, handleVersion } from '../commands/handlers.js';
import type { CommandContext } from '../commands/router.js';
import type { Session } from '../session.js';

function ctx(session: Partial<Session>): CommandContext {
  const fullSession = {
    workingDirectory: 'D:/work/project',
    state: 'idle',
    chatHistory: [],
    maxHistoryLength: 100,
    ...session,
  } as unknown as Session;

  return {
    accountId: 'account-1',
    session: fullSession,
    updateSession: (partial: Partial<Session>) => Object.assign(fullSession, partial),
    clearSession: () => fullSession,
    text: '',
  };
}

test('handleModel usage names Codex models', () => {
  const result = handleModel(ctx({}), '');
  assert.equal(result.handled, true);
  assert.match(result.reply ?? '', /Codex/);
  assert.match(result.reply ?? '', /gpt-5\.5/);
});

test('handleStatus reports Codex provider and agent session id', () => {
  const result = handleStatus(ctx({
    model: 'gpt-5.5',
    provider: 'codex',
    providerSessionIds: { codex: '019f25e1-b61f-7023-932c-1dbff6771bbb' },
  } as Partial<Session>));

  assert.equal(result.handled, true);
  assert.match(result.reply ?? '', /Provider: Codex/);
  assert.match(result.reply ?? '', /Model: gpt-5\.5/);
  assert.match(result.reply ?? '', /Session ID: 019f25e1-b61f-7023-932c-1dbff6771bbb/);
});

test('handleProvider switches between Codex and Claude', () => {
  const commandCtx = ctx({ provider: 'codex' } as Partial<Session>);

  const result = handleProvider(commandCtx, 'claude');

  assert.equal(result.handled, true);
  assert.equal((commandCtx.session as any).provider, 'claude');
  assert.match(result.reply ?? '', /Claude/);
});

test('handleStatus reports Claude provider session id independently', () => {
  const result = handleStatus(ctx({
    provider: 'claude',
    providerSessionIds: {
      codex: 'codex-session',
      claude: 'claude-session',
    },
  } as Partial<Session>));

  assert.equal(result.handled, true);
  assert.match(result.reply ?? '', /Provider: Claude/);
  assert.match(result.reply ?? '', /Session ID: claude-session/);
});

test('handleCompact clears only the current provider session id', () => {
  const commandCtx = ctx({
    provider: 'claude',
    providerSessionIds: {
      codex: 'codex-session',
      claude: 'claude-session',
    },
  } as Partial<Session>);

  const result = handleCompact(commandCtx);

  assert.equal(result.handled, true);
  assert.deepEqual((commandCtx.session as any).providerSessionIds, { codex: 'codex-session' });
});

test('handleVersion returns the package name users installed', () => {
  const result = handleVersion();
  assert.equal(result.handled, true);
  assert.match(result.reply ?? '', /^wechat-ai-coder v/);
});
