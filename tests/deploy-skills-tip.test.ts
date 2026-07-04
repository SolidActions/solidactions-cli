import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hasSolidActionsSkills } from '../src/utils/skills';

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
