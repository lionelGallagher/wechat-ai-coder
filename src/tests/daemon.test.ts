import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  buildWindowsStartConfig,
  createDaemonPaths,
  getPidStatus,
} from '../daemon.js';

test('createDaemonPaths stores pid and redirected output under data directory', () => {
  const paths = createDaemonPaths('C:/Users/lionel/.wechat-claude-code');

  assert.equal(paths.pidFile, join('C:/Users/lionel/.wechat-claude-code', 'wechat-ai-coder.pid'));
  assert.equal(paths.stdoutLog, join('C:/Users/lionel/.wechat-claude-code', 'logs', 'stdout.log'));
  assert.equal(paths.stderrLog, join('C:/Users/lionel/.wechat-claude-code', 'logs', 'stderr.log'));
});

test('buildWindowsStartConfig starts main daemon detached and hidden', () => {
  const config = buildWindowsStartConfig({
    nodePath: 'C:/Program Files/nodejs/node.exe',
    mainPath: 'D:/project/dist/main.js',
    projectDir: 'D:/project',
    env: { PATH: 'C:/bin' },
    stdio: ['ignore', 1, 2],
  });

  assert.equal(config.command, 'C:/Program Files/nodejs/node.exe');
  assert.deepEqual(config.args, ['D:/project/dist/main.js', 'start']);
  assert.equal(config.options.cwd, 'D:/project');
  assert.equal(config.options.detached, true);
  assert.equal(config.options.windowsHide, true);
  assert.deepEqual(config.options.stdio, ['ignore', 1, 2]);
  assert.equal(config.options.env?.PATH, 'C:/bin');
});

test('getPidStatus reports not running when pid file is missing', () => {
  const status = getPidStatus('D:/missing/wechat-ai-coder.pid');

  assert.deepEqual(status, { running: false, message: 'Not running' });
});
