import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hasSolidActionsSkills } from '../src/utils/skills';
import { SKILLS_TIP_LINES } from '../src/commands/deploy';

function tmpProject(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skills-test-'));
}

describe('hasSolidActionsSkills', () => {
    it('is false for a bare project directory', () => {
        const dir = tmpProject();
        expect(hasSolidActionsSkills(dir)).toBe(false);
    });

    it('is true when .claude/skills contains a solidactions-*.md file', () => {
        const dir = tmpProject();
        const skills = path.join(dir, '.claude', 'skills');
        fs.mkdirSync(skills, { recursive: true });
        fs.writeFileSync(path.join(skills, 'solidactions-getting-started.md'), '# skill');
        expect(hasSolidActionsSkills(dir)).toBe(true);
    });

    it('is true for the .agents/skills variant', () => {
        const dir = tmpProject();
        const skills = path.join(dir, '.agents', 'skills');
        fs.mkdirSync(skills, { recursive: true });
        fs.writeFileSync(path.join(skills, 'solidactions-workflow-coding.md'), '# skill');
        expect(hasSolidActionsSkills(dir)).toBe(true);
    });

    it('ignores unrelated markdown in the skills dir', () => {
        const dir = tmpProject();
        const skills = path.join(dir, '.claude', 'skills');
        fs.mkdirSync(skills, { recursive: true });
        fs.writeFileSync(path.join(skills, 'my-notes.md'), '# not ours');
        expect(hasSolidActionsSkills(dir)).toBe(false);
    });
});

describe('SKILLS_TIP_LINES — remedy printed when skills are missing', () => {
    it('points at `ai init`, not the non-empty-dir `init` or the unrelated `skill push`', () => {
        const tip = SKILLS_TIP_LINES.join(' ');
        expect(tip).toContain('ai init');
        expect(tip).not.toContain('skill push');
    });
});
