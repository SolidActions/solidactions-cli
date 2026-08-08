// #1004 PR 0: the build must emit dist/command-manifest.json, and that artifact
// must agree with a freshly-walked program — a stale artifact is the exact
// drift this manifest exists to prevent.
import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { buildCommandManifest } from '../src/utils/command-manifest';

const DIST = path.resolve(__dirname, '../dist');
const MANIFEST_PATH = path.join(DIST, 'command-manifest.json');
const CLI_BINARY = path.join(DIST, 'index.js');
const pkg = require('../package.json');

describe('command-manifest.json build artifact', () => {
    it('is emitted by the build', () => {
        expect(fs.existsSync(MANIFEST_PATH)).toBe(true); // run `npm run build` first
    });

    it('is valid JSON carrying the schema version and the package version', () => {
        const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

        expect(manifest.schema_version).toBe(1);
        expect(manifest.cli_name).toBe('solidactions');
        expect(manifest.cli_version).toBe(pkg.version);
    });

    it('matches a manifest walked fresh from the built program', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
        const { program } = require(CLI_BINARY);

        const onDisk = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        const fresh = JSON.parse(JSON.stringify(buildCommandManifest(program, pkg.version)));

        expect(onDisk).toEqual(fresh);
    });

    it('ships inside dist/, which is the only published directory', () => {
        expect(pkg.files).toContain('dist');
        expect(path.relative(DIST, MANIFEST_PATH)).toBe('command-manifest.json');
    });

    it('is present in the npm pack file list', () => {
        const packed = JSON.parse(execFileSync(
            'npm',
            ['pack', '--dry-run', '--json', '--ignore-scripts'],
            { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' },
        ));
        const files = packed.flatMap((artifact: any) => artifact.files.map((file: any) => file.path));

        expect(files).toContain('dist/command-manifest.json');
    });
});
