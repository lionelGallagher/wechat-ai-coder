import { readdirSync, readFileSync, existsSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../logger.js';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 * Only extracts `name` and `description` fields.
 */
function parseSkillMd(filePath: string): { name: string; description: string } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const frontmatter = match[1];
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

    if (!nameMatch) return null;

    return {
      name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
      description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : '',
    };
  } catch {
    logger.warn(`Failed to read SKILL.md: ${filePath}`);
    return null;
  }
}

/**
 * Scan a directory for SKILL.md files, reading skill info from each.
 */
function scanDirectory(baseDir: string, depth: number = 2): SkillInfo[] {
  const skills: SkillInfo[] = [];

  if (!existsSync(baseDir)) return skills;

  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(baseDir, entry.name);

    if (depth > 1) {
      // Recurse one level deeper
      skills.push(...scanDirectory(fullPath, depth - 1));
    }

    const skillFile = join(fullPath, 'SKILL.md');
    if (existsSync(skillFile)) {
      const info = parseSkillMd(skillFile);
      if (info) {
        skills.push({ ...info, path: fullPath });
      }
    }
  }

  return skills;
}

function addUnique(skills: SkillInfo[], seen: Set<string>, skill: SkillInfo): void {
  if (!seen.has(skill.name)) {
    seen.add(skill.name);
    skills.push(skill);
  }
}

/**
 * Scan Codex and legacy Claude-style skill roots.
 *
 * Locations scanned under each root:
 * 1. skills/ (each subdirectory)
 * 2. plugins/cache/{plugin}/skills/ (each subdirectory)
 * 3. plugins/cache/{plugin}/superpowers/skills/ (each subdirectory)
 */
export function scanSkillDirectories(skillRoots: string[]): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();

  for (const rootDir of skillRoots) {
    const userSkillsDir = join(rootDir, 'skills');
    for (const skill of scanDirectory(userSkillsDir, 1)) {
      addUnique(skills, seen, skill);
    }

    const pluginsCacheDir = join(rootDir, 'plugins', 'cache');
    if (existsSync(pluginsCacheDir)) {
      let cacheEntries: Dirent[];
      try {
        cacheEntries = readdirSync(pluginsCacheDir, { withFileTypes: true });
      } catch {
        cacheEntries = [];
      }

      for (const cacheEntry of cacheEntries) {
        if (!cacheEntry.isDirectory()) continue;
        const cacheDir = join(pluginsCacheDir, cacheEntry.name);

        const pluginSkillsDir = join(cacheDir, 'skills');
        for (const skill of scanDirectory(pluginSkillsDir, 1)) {
          addUnique(skills, seen, skill);
        }

        const superpowersSkillsDir = join(cacheDir, 'superpowers', 'skills');
        for (const skill of scanDirectory(superpowersSkillsDir, 1)) {
          addUnique(skills, seen, skill);
        }
      }
    }
  }

  return skills;
}

export function scanAllSkills(): SkillInfo[] {
  const home = homedir();
  const skills = scanSkillDirectories([
    join(home, '.codex'),
    join(home, '.claude'),
  ]);

  logger.info(`Scanned ${skills.length} skills`);
  return skills;
}

/**
 * Format a list of skills into a readable string for display.
 */
export function formatSkillList(skills: SkillInfo[]): string {
  if (skills.length === 0) {
    return 'No skills found.';
  }

  const lines = skills.map((s, i) => {
    const desc = s.description ? ` - ${s.description}` : '';
    return `  ${i + 1}. ${s.name}${desc}`;
  });

  return `Available skills (${skills.length}):\n${lines.join('\n')}`;
}

/**
 * Find a skill by name (case-insensitive match).
 */
export function findSkill(skills: SkillInfo[], name: string): SkillInfo | undefined {
  const lower = name.toLowerCase();
  return skills.find(
    (s) => s.name.toLowerCase() === lower || s.name.toLowerCase().replace(/\s+/g, '-') === lower,
  );
}
