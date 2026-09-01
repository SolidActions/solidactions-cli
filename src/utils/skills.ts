import fs from 'fs';
import path from 'path';
import fsExtra from 'fs-extra';
import { fetchRawFile } from './github';
import { EXAMPLES_REF } from './examples-ref';

export const BUNDLED_SKILLS_VERSION = EXAMPLES_REF;
export const SKILLS_VERSION_FILE = '.solidactions-version';

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

    // Stamp only after every fetch/write succeeds. A partial/offline install
    // must remain visibly stale so the next run can tell the agent to repair it.
    const versionFile = path.join(targetDir, SKILLS_VERSION_FILE);
    fs.writeFileSync(versionFile, `${BUNDLED_SKILLS_VERSION}\n`, 'utf8');
    written.push(versionFile);

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
    return findInstalledSkillDirs(projectDir).length > 0;
}

/** Return every helper-specific directory containing SolidActions skills. */
export function findInstalledSkillDirs(projectDir: string): string[] {
    const installed: string[] = [];
    for (const target of ['CLAUDE.md', 'AGENTS.md'] as AiHelperTarget[]) {
        const dir = skillTargetDir(target, projectDir);
        if (!fs.existsSync(dir)) {
            continue;
        }
        try {
            const entries = fs.readdirSync(dir);
            if (entries.some((f) => f.startsWith('solidactions-') && f.endsWith('.md'))) {
                installed.push(dir);
            }
        } catch {
            // Advisory discovery must not make an otherwise valid CLI command fail.
        }
    }
    return installed;
}

export function isSkillDirCurrent(skillDir: string): boolean {
    try {
        return fs.readFileSync(path.join(skillDir, SKILLS_VERSION_FILE), 'utf8').trim() === BUNDLED_SKILLS_VERSION;
    } catch {
        return false;
    }
}
