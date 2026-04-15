import fs from 'fs';
import path from 'path';
import fsExtra from 'fs-extra';
import { fetchRawFile } from './github';

const SKILL_NAMES = [
    'solidactions-getting-started',
    'solidactions-workflow-coding',
    'solidactions-deploy-and-config',
] as const;

const EXAMPLES_OWNER = 'SolidActions';
const EXAMPLES_REPO = 'solidactions-examples';
const SKILLS_PATH_PREFIX = 'skills';

/**
 * Detect which AI-tool skill directories should receive skills.
 * Returns absolute paths to the target skills/ subdirectories.
 *
 * v1 supports Claude Code only. Codex was resolved as user-global
 * (~/.codex/skills) with no project-local equivalent, so it is
 * intentionally NOT a target here.
 *
 * Detection rules:
 * - If `.claude/` exists in cwd → include `.claude/skills/`
 * - If neither exists → return empty (caller should prompt)
 */
export function detectSkillTargets(cwd: string = process.cwd()): string[] {
    const targets: string[] = [];
    if (fs.existsSync(path.join(cwd, '.claude'))) {
        targets.push(path.join(cwd, '.claude', 'skills'));
    }
    return targets;
}

/**
 * Fetch all SolidActions skill files from the examples repo and write
 * them into each target directory. Overwrites existing files (skills
 * are versioned upstream).
 */
export async function installSkills(targetDirs: string[]): Promise<{ written: string[] }> {
    const written: string[] = [];

    for (const dir of targetDirs) {
        fsExtra.ensureDirSync(dir);
    }

    for (const skillName of SKILL_NAMES) {
        const remotePath = `${SKILLS_PATH_PREFIX}/${skillName}.md`;
        const content = await fetchRawFile(EXAMPLES_OWNER, EXAMPLES_REPO, remotePath);

        for (const dir of targetDirs) {
            const filePath = path.join(dir, `${skillName}.md`);
            fs.writeFileSync(filePath, content, 'utf8');
            written.push(filePath);
        }
    }

    return { written };
}

/**
 * Pick the right CLAUDE.md content variant from the examples repo
 * based on whether skills are being installed.
 *
 * - skillsInstalled = true  → fetches CLAUDE-skills-pointer.md (slim)
 * - skillsInstalled = false → fetches CLAUDE.md (full, legacy)
 */
export async function fetchClaudeMdContent(skillsInstalled: boolean): Promise<string> {
    const file = skillsInstalled ? 'CLAUDE-skills-pointer.md' : 'CLAUDE.md';
    return fetchRawFile(EXAMPLES_OWNER, EXAMPLES_REPO, file);
}
