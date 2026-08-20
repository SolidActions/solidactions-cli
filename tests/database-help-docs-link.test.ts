/**
 * Pins that `database --help` points users at the Workspace Databases docs
 * page for connecting directly (outside the CLI) over HTTP or libSQL.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

describe('database --help — direct-connection docs pointer', () => {
    it('CLI is built', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
    });

    it('surfaces the workspace-databases docs URL', () => {
        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_BINARY, 'database', '--help'],
            { encoding: 'utf8', timeout: 15_000 },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('https://www.solidactions.com/docs/workspace-databases/');
    });
});
