/**
 * #140 review R5 — the whole point of resolving database credentials inside
 * `dev --env` rather than through `env pull` is that they stay in memory. This
 * test polices that mechanically instead of by inspection.
 *
 * `env pull` already has its equivalent assertion (its .env must contain no
 * credential-looking string). This is the `dev` half: run a real `dev --env`
 * with a mapped database whose token is a distinctive sentinel, with HOME and
 * TMPDIR pointed at a scratch directory, then walk every file written anywhere
 * under that directory and assert the sentinel appears in none of them.
 *
 * The scratch redirection matters: `dev` writes a private temp result file for
 * the shim under os.tmpdir() (which honours TMPDIR), and the spawned child
 * inherits this process's env — so both the parent's and the child's writes
 * land inside the tree this test then sweeps.
 *
 * The fixture returns NO credential bytes, only facts about the DatabaseVar. A
 * workflow that returned its own token would put it in the shim result file
 * legitimately — inherent to returning a secret from your own workflow, and
 * out of the CLI's hands — and would mask the property under test.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDev, type PlatformVar, type SaApiClient } from '../src/commands/dev';

const DB_FACTS_FIXTURE = path.resolve(__dirname, '../fixtures/db-facts.ts');

/**
 * A token that cannot collide with anything else on disk, so a hit is proof of
 * a real leak rather than an accident of common text.
 */
const SENTINEL_TOKEN = 'sa-dev-leak-canary-a4f19c2e8b7d40518c3countersign';
const SENTINEL_URL = 'libsql://leak-canary-9f31.turso.io';

const DB_MAPPING: PlatformVar = {
    env_name: 'APP_DB',
    source_type: 'workspace_database',
    resolved_value: null,
    workspace_database_name: 'canary',
};

function fakeApi(): SaApiClient {
    return {
        projectSlug: 'my-proj',
        async fetchVarsAndConnections(): Promise<PlatformVar[]> {
            return [DB_MAPPING];
        },
        async resolveDatabaseCredential(name: string) {
            return { url: SENTINEL_URL, token: SENTINEL_TOKEN, name, read_only: false };
        },
    };
}

/** Every regular file under `dir`, recursively, following no symlinks. */
function walkFiles(dir: string, found: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return found; // vanished mid-walk (a temp file being cleaned up) — fine
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(full, found);
        else if (entry.isFile()) found.push(full);
    }
    return found;
}

/** Files under `dir` whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
    return walkFiles(dir).filter((file) => {
        try {
            return fs.readFileSync(file).includes(Buffer.from(needle, 'utf8'));
        } catch {
            return false;
        }
    });
}

describe('dev --env never writes a database credential to disk', () => {
    let scratch: string;
    let originalHome: string | undefined;
    let originalTmpdir: string | undefined;

    beforeEach(() => {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-dev-disk-safety-'));
        fs.mkdirSync(path.join(scratch, 'home'), { recursive: true });
        fs.mkdirSync(path.join(scratch, 'tmp'), { recursive: true });

        originalHome = process.env.HOME;
        originalTmpdir = process.env.TMPDIR;
        process.env.HOME = path.join(scratch, 'home');
        process.env.TMPDIR = path.join(scratch, 'tmp');
    });

    afterEach(() => {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = originalTmpdir;
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    it('leaves the token and url in no file under HOME or TMPDIR', async () => {
        // Sanity: TMPDIR really is redirected, or the sweep below proves nothing.
        expect(os.tmpdir()).toBe(path.join(scratch, 'tmp'));

        const out = await runDev({
            entry: DB_FACTS_FIXTURE,
            input: '{}',
            env: 'staging',
            api: fakeApi(),
        });

        // The credential genuinely reached the workflow — otherwise "nothing on
        // disk" would be trivially true because nothing was resolved at all.
        expect(out.result.status).toBe('completed');
        expect(out.result.output).toMatchObject({
            isObject: true,
            name: 'canary',
            readOnly: false,
            tokenIsString: true,
            tokenLength: SENTINEL_TOKEN.length,
        });
        expect(out.stdout).toContain('+ 1 database');

        expect(filesContaining(scratch, SENTINEL_TOKEN)).toEqual([]);
        expect(filesContaining(scratch, SENTINEL_URL)).toEqual([]);
    }, 30_000);

    it('keeps the token out of the CLI\'s own stdout and stderr', async () => {
        // A credential echoed to the terminal ends up in shell scrollback, CI
        // logs and pasted bug reports — a different disk, same leak.
        const out = await runDev({
            entry: DB_FACTS_FIXTURE,
            input: '{}',
            env: 'staging',
            api: fakeApi(),
        });

        expect(out.stdout).not.toContain(SENTINEL_TOKEN);
        expect(out.stderr).not.toContain(SENTINEL_TOKEN);
        expect(out.stdout).not.toContain(SENTINEL_URL);
        expect(out.stderr).not.toContain(SENTINEL_URL);
    }, 30_000);

    it('the sweep can actually detect a leak (guards the guard)', () => {
        // If walkFiles/filesContaining silently found nothing — wrong root, an
        // unreadable tree — the assertions above would pass against leaking
        // code. Plant the sentinel and prove the sweep sees it.
        const planted = path.join(scratch, 'tmp', 'planted.json');
        fs.writeFileSync(planted, `{"token":"${SENTINEL_TOKEN}"}`);
        expect(filesContaining(scratch, SENTINEL_TOKEN)).toEqual([planted]);
    });
});
