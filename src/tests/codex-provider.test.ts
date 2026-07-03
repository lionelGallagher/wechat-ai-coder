import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexCommand,
  buildCodexSpawnOptions,
  handleCodexJsonLine,
  type CodexParserState,
} from '../codex/provider.js';

function freshState(): CodexParserState {
  return { sessionId: '', textParts: [] };
}

test('handleCodexJsonLine stores thread.started thread_id as sessionId', () => {
  const state = freshState();
  handleCodexJsonLine(
    JSON.stringify({ type: 'thread.started', thread_id: '019f25e1-b61f-7023-932c-1dbff6771bbb' }),
    state,
    {},
  );
  assert.equal(state.sessionId, '019f25e1-b61f-7023-932c-1dbff6771bbb');
});

test('handleCodexJsonLine streams and accumulates completed agent messages', () => {
  const state = freshState();
  const calls: string[] = [];
  handleCodexJsonLine(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'PONG' },
    }),
    state,
    { onText: (text: string) => calls.push(text) },
  );
  assert.deepEqual(calls, ['PONG']);
  assert.deepEqual(state.textParts, ['PONG']);
});

test('handleCodexJsonLine maps turn.completed to end_turn', () => {
  const calls: string[] = [];
  handleCodexJsonLine(
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
    freshState(),
    { onTurnEnd: (reason: string) => calls.push(reason) },
  );
  assert.deepEqual(calls, ['end_turn']);
});

test('handleCodexJsonLine records turn.failed and error messages', () => {
  const failedState = freshState();
  handleCodexJsonLine(
    JSON.stringify({ type: 'turn.failed', error: { message: 'model unavailable' } }),
    failedState,
    {},
  );
  assert.equal(failedState.errorMessage, 'model unavailable');

  const errorState = freshState();
  handleCodexJsonLine(
    JSON.stringify({ type: 'error', message: 'auth failed' }),
    errorState,
    {},
  );
  assert.equal(errorState.errorMessage, 'auth failed');
});

test('handleCodexJsonLine clears transient error when turn later completes', () => {
  const state = freshState();
  handleCodexJsonLine(
    JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5' }),
    state,
    {},
  );
  handleCodexJsonLine(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'PONG' },
    }),
    state,
    {},
  );
  handleCodexJsonLine(
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
    state,
    {},
  );

  assert.equal(state.errorMessage, undefined);
  assert.deepEqual(state.textParts, ['PONG']);
});

test('buildCodexCommand creates first-run codex exec args for stdin prompt', () => {
  const command = buildCodexCommand({
    cwd: 'D:/work/project',
    model: 'gpt-5.5',
    imagePaths: ['D:/tmp/a.png', 'D:/tmp/b.png'],
  });

  const expectedArgs = [
    'exec',
    '--json',
    '--cd',
    'D:/work/project',
    '--sandbox',
    'danger-full-access',
    '-c',
    'approval_policy="never"',
    '--model',
    'gpt-5.5',
    '--image',
    'D:/tmp/a.png',
    '--image',
    'D:/tmp/b.png',
    '-',
  ];

  if (process.platform === 'win32') {
    assert.equal(command.command, process.execPath);
    assert.match(command.args[0], /node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
    assert.deepEqual(command.args.slice(1), expectedArgs);
  } else {
    assert.equal(command.command, 'codex');
    assert.deepEqual(command.args, expectedArgs);
  }
});

test('buildCodexCommand creates resume args with sandbox config override', () => {
  const command = buildCodexCommand({
    cwd: 'D:/work/project',
    resume: '019f25e1-b61f-7023-932c-1dbff6771bbb',
  });

  const expectedArgs = [
    'exec',
    'resume',
    '--json',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="danger-full-access"',
    '019f25e1-b61f-7023-932c-1dbff6771bbb',
    '-',
  ];

  if (process.platform === 'win32') {
    assert.equal(command.command, process.execPath);
    assert.match(command.args[0], /node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
    assert.deepEqual(command.args.slice(1), expectedArgs);
  } else {
    assert.equal(command.command, 'codex');
    assert.deepEqual(command.args, expectedArgs);
  }
});

test('buildCodexSpawnOptions does not use shell so paths with spaces stay intact', () => {
  const options = buildCodexSpawnOptions('D:/work/project');
  assert.equal(options.cwd, 'D:/work/project');
  assert.equal(options.shell, false);
});
