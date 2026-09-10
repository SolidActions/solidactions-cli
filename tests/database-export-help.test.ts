import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

function exportHelp(): string {
    const result = childProcess.spawnSync(
        process.execPath,
        [CLI_BINARY, 'database', 'export', '--help'],
        { encoding: 'utf8', timeout: 15_000 },
    );
    expect(result.status).toBe(0);
    return result.stdout;
}

describe('database export --help safety and integrity contract', () => {
    it('CLI is built', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
    });

    it('documents the artifact, destination, verification, refresh, resume, and JSON guarantees', () => {
        const help = exportHelp();

        expect(help).toMatch(/Parquet files and manifest\.json only/);
        expect(help).toMatch(/new exports require an absent or empty destination/i);
        expect(help).toMatch(/never overwrite files/i);
        expect(help).toMatch(/authenticated API manifest digest/i);
        expect(help).toMatch(/file byte length and SHA-256/i);
        expect(help).toMatch(/signed links are refreshed once on expiry/i);
        expect(help).toMatch(/--resume <export-id>/);
        expect(help).toMatch(/JSON output never includes signed URLs/i);
    });
});
