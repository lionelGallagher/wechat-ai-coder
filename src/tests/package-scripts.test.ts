import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function packageJson(): { scripts: Record<string, string> } {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
}

test('npm start launches the background daemon manager', () => {
  const pkg = packageJson();

  assert.equal(pkg.scripts.start, 'node dist/daemon.js start');
});

test('foreground script keeps an explicit blocking mode available', () => {
  const pkg = packageJson();

  assert.equal(pkg.scripts.foreground, 'node dist/main.js start');
});
