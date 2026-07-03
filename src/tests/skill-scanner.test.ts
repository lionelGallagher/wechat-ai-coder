import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanSkillDirectories } from '../claude/skill-scanner.js';
import type { SkillInfo } from '../claude/skill-scanner.js';

function writeSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n`,
    'utf-8',
  );
}

test('scanSkillDirectories scans Codex and legacy Claude skill roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'wac-skills-'));
  try {
    const codexRoot = join(root, '.codex');
    const claudeRoot = join(root, '.claude');
    writeSkill(join(codexRoot, 'skills', 'codex-skill'), 'codex-skill');
    writeSkill(join(codexRoot, 'plugins', 'cache', 'plugin-a', 'skills', 'plugin-skill'), 'plugin-skill');
    writeSkill(join(codexRoot, 'plugins', 'cache', 'plugin-a', 'superpowers', 'skills', 'super-skill'), 'super-skill');
    writeSkill(join(claudeRoot, 'skills', 'legacy-skill'), 'legacy-skill');

    const names = scanSkillDirectories([codexRoot, claudeRoot]).map((skill: SkillInfo) => skill.name).sort();

    assert.deepEqual(names, ['codex-skill', 'legacy-skill', 'plugin-skill', 'super-skill']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
