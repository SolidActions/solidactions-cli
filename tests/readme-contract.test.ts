import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SOLIDACTIONS_SKILL_NAMES } from '../src/utils/skills';

const README = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');

describe('public README setup contract', () => {
    it('uses the secret-safe current login, deploy, and run commands', () => {
        expect(README).toContain('solidactions login --global');
        expect(README).toContain('solidactions login --stdin --global');
        expect(README).toContain('solidactions project deploy my-project -e production');
        expect(README).toContain('solidactions run start my-project hello -e production');
        expect(README).toContain('solidactions schedule set my-project');
        expect(README).toContain('--timezone America/Chicago');
        expect(README).toContain('--wait');

        expect(README).not.toContain('solidactions login <api-key>');
        expect(README).not.toContain('solidactions init <api-key>');
        expect(README).not.toContain('solidactions deploy <project-name>');
        expect(README).not.toContain('solidactions project deploy my-project --env');
        expect(README).not.toContain('docs.solidactions.com');
        expect(README).toContain('https://www.solidactions.com/docs');
        expect(README).not.toContain('https://solidactions.com/docs');
    });

    it('documents every skill in the generated manifest', () => {
        for (const skillName of SOLIDACTIONS_SKILL_NAMES) {
            expect(README).toContain(`\`${skillName}\``);
        }
    });
});
