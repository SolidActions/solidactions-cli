import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SOLIDACTIONS_SKILL_NAMES } from '../src/utils/skills';

const README = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');
const COMMAND_TAXONOMY = fs.readFileSync(
    path.resolve(__dirname, '../docs/decisions/0001-cli-command-taxonomy.md'),
    'utf8',
);

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

    it('documents activation lifecycle commands and state visibility', () => {
        expect(README).toContain('project enable <project>');
        expect(README).toContain('project disable <project>');
        expect(README).toContain('workflow enable <project> <workflow>');
        expect(README).toContain('workflow disable <project> <workflow>');
        expect(README).toContain('environment:on/off');
        expect(README).toContain('Enabled: on|off');
        expect(README).toContain('blocked (project off)');

        expect(COMMAND_TAXONOMY).toMatch(/activation-lifecycle/i);
        expect(COMMAND_TAXONOMY).toMatch(/`enable`\s*\/\s*`disable`/);
    });

    it('documents project view default-dev targeting and exact-suffix migration', () => {
        expect(README).toContain('`project view <project>` | `-e` (default `dev`)');
        expect(README).toMatch(/omitting\s+`--env` targets dev/);
        expect(README).toContain('`billing` resolves to `billing-dev`');
        expect(README).toContain('Use `--env production`');
        expect(README).toMatch(/`project view billing-dev` now\s+targets `billing-dev-dev`/);
        expect(README).toContain('legitimate production slug');

        expect(README).not.toContain('omitting `--env` treats `<project>` as an exact slug');
        expect(README).not.toContain('project view has no implicit');
    });
});
