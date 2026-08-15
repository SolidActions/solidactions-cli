/**
 * Pins the user-facing `project view` targeting contract on the real built CLI.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

describe('project view --help — environment targeting contract', () => {
    it('CLI is built', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
    });

    it('describes a project family with a dev default and production opt-in', () => {
        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_BINARY, 'project', 'view', '--help'],
            { encoding: 'utf8', timeout: 15_000 },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Usage:.*<project>/);
        expect(result.stdout).toMatch(/Arguments:\s+project\s+Project family slug or name/);
        expect(result.stdout).toContain('Defaults to dev');
        expect(result.stdout).toContain('--json');
        expect(result.stdout).toContain('Use --env production');
        expect(result.stdout).not.toContain('Exact project slug');
        expect(result.stdout).not.toContain('used as an exact slug');
        expect(result.stdout).not.toContain('no implicit dev environment default');
    });
});
