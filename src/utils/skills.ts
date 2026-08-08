import fs from 'fs';
import path from 'path';
import fsExtra from 'fs-extra';
import { fetchRawFile } from './github';
import { EXAMPLES_REF } from './examples-ref';

export const SOLIDACTIONS_SKILL_NAMES = [
    'solidactions-getting-started',
    'solidactions-workflow-coding',
    'solidactions-deploy-and-config',
    'solidactions-oauth-actions',
    'solidactions-crew-skills',
] as const;

const EXAMPLES_OWNER = 'SolidActions';
const EXAMPLES_REPO = 'solidactions-examples';
const SKILLS_PATH_PREFIX = 'content/skills';

export type AiHelperTarget = 'CLAUDE.md' | 'AGENTS.md';

/**
 * Resolve the skills directory for an AI helper target.
 *
 * - `CLAUDE.md` → `<cwd>/.claude/skills/` (Claude Code convention)
 * - `AGENTS.md` → `<cwd>/.agents/skills/` (Codex auto-discovers this path;
 *   Cursor/Gemini read via AGENTS.md pointers)
 *
 * The directory does not need to exist — the caller creates it.
 */
export function skillTargetDir(targetFile: AiHelperTarget, cwd: string = process.cwd()): string {
    if (targetFile === 'CLAUDE.md') {
        return path.join(cwd, '.claude', 'skills');
    }
    return path.join(cwd, '.agents', 'skills');
}

/**
 * Fetch all SolidActions skill files from the examples repo and write
 * them into the target directory. Overwrites existing files (skills
 * are versioned upstream).
 */
export async function installSkills(targetDir: string): Promise<{ written: string[] }> {
    const written: string[] = [];

    fsExtra.ensureDirSync(targetDir);

    for (const skillName of SOLIDACTIONS_SKILL_NAMES) {
        const remotePath = `${SKILLS_PATH_PREFIX}/${skillName}.md`;
        const content = await fetchRawFile(EXAMPLES_OWNER, EXAMPLES_REPO, remotePath, EXAMPLES_REF);

        const filePath = path.join(targetDir, `${skillName}.md`);
        fs.writeFileSync(filePath, content, 'utf8');
        written.push(filePath);
    }

    return { written };
}

/**
 * Fetch the slim AI-helper content for the target file from the examples
 * repo. Single source per target — no legacy fallback.
 */
export async function fetchAiHelperContent(targetFile: AiHelperTarget): Promise<string> {
    return fetchRawFile(EXAMPLES_OWNER, EXAMPLES_REPO, targetFile, EXAMPLES_REF);
}

/**
 * True when the project dir already has SolidActions skill files installed
 * (either AI-helper convention). Used by `deploy` for a non-blocking tip —
 * these files are how AI assistants self-rescue on env-scope/deploy traps.
 */
export function hasSolidActionsSkills(projectDir: string): boolean {
    for (const target of ['CLAUDE.md', 'AGENTS.md'] as AiHelperTarget[]) {
        const dir = skillTargetDir(target, projectDir);
        if (!fs.existsSync(dir)) {
            continue;
        }
        const entries = fs.readdirSync(dir);
        if (entries.some((f) => f.startsWith('solidactions-') && f.endsWith('.md'))) {
            return true;
        }
    }
    return false;
}
