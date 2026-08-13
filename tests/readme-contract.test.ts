import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SOLIDACTIONS_SKILL_NAMES } from '../src/utils/skills';

const README = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');
const COMMAND_TAXONOMY = fs.readFileSync(
    path.resolve(__dirname, '../docs/decisions/0001-cli-command-taxonomy.md'),
    'utf8',
);

function markdownSection(markdown: string, heading: string): string {
    const start = markdown.indexOf(heading);
    expect(start, `missing ${heading}`).toBeGreaterThanOrEqual(0);
    const next = markdown.indexOf('\n## ', start + heading.length);
    return markdown.slice(start, next === -1 ? undefined : next);
}

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
        expect(README).toContain('workflow view <project> <workflow>');
        expect(README).toContain('Enabled source:');
        expect(README).toContain('environment:on/off');
        expect(README).toContain('Enabled: on|off');
        expect(README).toContain('blocked (project off)');

        expect(COMMAND_TAXONOMY).toMatch(/activation-lifecycle/i);
        expect(COMMAND_TAXONOMY).toMatch(/`enable`\s*\/\s*`disable`/);
        expect(COMMAND_TAXONOMY).toMatch(/workflow[\s\S]*single-resource[\s\S]*`view`/i);
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

    it('documents the complete vendor-neutral database CLI and its safety model', () => {
        const guidance = markdownSection(README, '## Database CLI');
        const commands = [
            'solidactions database list',
            'solidactions database create',
            'solidactions database delete',
            'solidactions database undelete',
            'solidactions database schema',
            'solidactions database query',
            'solidactions database exec',
            'solidactions database dump',
            'solidactions database pull',
            'solidactions database import',
        ];

        for (const command of commands) {
            expect(guidance, `README missing ${command}`).toContain(command);
        }

        for (const option of ['--json', '--yes', '--from', '--writable', '--resume']) {
            expect(guidance, `README missing ${option}`).toContain(option);
        }

        expect(guidance).toMatch(/soft-delete/i);
        expect(guidance).toMatch(/purge clock/i);
        expect(guidance).toMatch(/read-only local replica/i);
        expect(guidance).toContain('.solidactions/databases/<safe-stem>.db');
        expect(guidance).toMatch(/foreground/i);
        expect(guidance).toMatch(/writes go to the live workspace database/i);
        expect(guidance).toMatch(/no offline (?:merge|write-back)/i);
        expect(guidance).toMatch(/ephemeral/i);
        expect(guidance).toMatch(/no durable credential/i);
        expect(guidance).toMatch(/DOWNLOAD INCOMPLETE/);
        expect(guidance).toMatch(/checkpoint/i);
        expect(guidance).toMatch(/avoid|without|no replay/i);
        expect(guidance).not.toMatch(/turso|libsql/i);
    });

    it('documents database binding setup and the SDK 0.8 transport boundary', () => {
        const guidance = markdownSection(README, '### Env declarations (`solidactions.yaml`)');

        expect(guidance).toContain('solidactions database create');
        expect(guidance).toMatch(/web UI/i);
        expect(guidance).toMatch(/@solidactions\/sdk.*>=\s*0\.8\.0/i);
        expect(guidance).toContain('read_only');
        expect(guidance).toContain('DatabaseVar.readOnly');
        expect(guidance).toMatch(/typed.*DatabaseVar/i);
    });
});
