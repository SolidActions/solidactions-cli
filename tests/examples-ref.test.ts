/**
 * #86 — every solidactions-examples fetch must be pinned to an explicit ref.
 *
 * `init`'s TEMPLATE_FILES loop (and the skills/AI-helper fetches beside it) used
 * fetchRawFile() with no ref, which defaults to `main`. That made the scaffold a
 * user receives — including the `@solidactions/sdk` version their new project
 * declares — depend on whatever was on that repo's default branch at that
 * moment. Same unpinned-fetch class as the SDK docs fetch fixed in #39.
 *
 * These tests assert the pinned URL directly, so any regression to a moving ref
 * fails here rather than silently shipping a drifting scaffold.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXAMPLES_REF } from '../src/utils/examples-ref';
import { rawContentUrl } from '../src/utils/github';
import { installSkills, fetchAiHelperContent } from '../src/utils/skills';

const PRE_DATABASE_GUIDANCE_REF = '3ca5fd4d3107659b27889775791f6691cf173303';
const RELEASE_SMOKE = fs.readFileSync(path.resolve(__dirname, '../scripts/smoke-init.mjs'), 'utf8');

describe('EXAMPLES_REF', () => {
    it('pins the merged examples mainline for CLI v3.8.0 (repinned per the #1146 release contract)', () => {
        expect(EXAMPLES_REF).toBe('5eaaaab417ef510401618b814a1eedf238752057');
    });

    it('records the mainline repin and the standing release-ritual contract without a fabricated override', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../src/utils/examples-ref.ts'), 'utf8');

        expect(source).toContain('merged solidactions-examples mainline');
        expect(source).toContain('mainline SHA');
        expect(source).toMatch(/on every CLI release/i);
        expect(source).toMatch(/release ritual/i);
        expect(source).not.toMatch(/PM[- ]directed|PM delivery override|override explicitly approved/i);
    });

    it('moves past the pre-database-guidance examples pin', () => {
        expect(EXAMPLES_REF).not.toBe(PRE_DATABASE_GUIDANCE_REF);
    });

    it('is an immutable ref, not a moving branch', () => {
        expect(EXAMPLES_REF).not.toBe('main');
        expect(EXAMPLES_REF).not.toBe('master');
        expect(EXAMPLES_REF).not.toBe('HEAD');
    });

    it('is a full 40-character commit SHA', () => {
        // A short SHA or a tag would still be pinned, but a full SHA is what the
        // constant documents and what smoke:init resolves against. If this pin
        // ever moves to a tag, update this assertion deliberately.
        expect(EXAMPLES_REF).toMatch(/^[0-9a-f]{40}$/);
    });
});

describe('solidactions-examples fetch URLs', () => {
    const templateUrl = (suffix: string) =>
        rawContentUrl('SolidActions', 'solidactions-examples', `templates/minimal/${suffix}`, EXAMPLES_REF);

    it('builds template URLs against the pinned ref, not main', () => {
        const url = templateUrl('package.json');
        expect(url).toBe(
            `https://raw.githubusercontent.com/SolidActions/solidactions-examples/${EXAMPLES_REF}/templates/minimal/package.json`,
        );
        expect(url).not.toContain('/main/');
    });

    it('pins package.json, which determines the scaffolded SDK version', () => {
        // This is the file the issue is actually about: an unpinned fetch here
        // means a new project's @solidactions/sdk range is set by whatever is on
        // the examples repo's default branch.
        expect(templateUrl('package.json')).toContain(`/${EXAMPLES_REF}/`);
        expect(templateUrl('package-lock.json')).toContain(`/${EXAMPLES_REF}/`);
    });

    it('pins skill and AI-helper fetches from the same repo', () => {
        for (const remotePath of ['skills/solidactions-getting-started.md', 'CLAUDE.md', 'AGENTS.md']) {
            const url = rawContentUrl('SolidActions', 'solidactions-examples', remotePath, EXAMPLES_REF);
            expect(url).toContain(`/${EXAMPLES_REF}/`);
            expect(url).not.toContain('/main/');
        }
    });
});

// ---------------------------------------------------------------------------
// Behavioural: a real local HTTP server records what the fetch code ACTUALLY
// requests. Asserting the URL builder alone would not catch a call site that
// simply stops passing the ref. No mocks — same policy as dev.test.ts.
// ---------------------------------------------------------------------------

describe('solidactions-examples fetches pass the pinned ref at the call site', () => {
    let server: http.Server;
    let requested: string[];
    let previousBaseUrl: string | undefined;
    let tmpDir: string;

    beforeAll(async () => {
        requested = [];
        server = http.createServer((req, res) => {
            requested.push(req.url ?? '');
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('stub content');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        previousBaseUrl = process.env.SOLIDACTIONS_RAW_CONTENT_BASE_URL;
        process.env.SOLIDACTIONS_RAW_CONTENT_BASE_URL = `http://127.0.0.1:${address.port}`;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solidactions-examples-ref-'));
    });

    afterAll(async () => {
        if (previousBaseUrl === undefined) {
            delete process.env.SOLIDACTIONS_RAW_CONTENT_BASE_URL;
        } else {
            process.env.SOLIDACTIONS_RAW_CONTENT_BASE_URL = previousBaseUrl;
        }
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('installSkills requests every skill at the pinned ref', async () => {
        requested = [];
        await installSkills(path.join(tmpDir, 'skills'));

        expect(requested.length).toBeGreaterThan(0);
        for (const url of requested) {
            expect(url).toContain(`/${EXAMPLES_REF}/`);
            expect(url).not.toMatch(/solidactions-examples\/main\//);
        }
        expect(requested.some((url) => url.endsWith(
            `/${EXAMPLES_REF}/content/skills/solidactions-deploy-and-config.md`,
        ))).toBe(true);
    });

    it('fetchAiHelperContent requests the helper file at the pinned ref', async () => {
        requested = [];
        await fetchAiHelperContent('CLAUDE.md');

        expect(requested).toHaveLength(1);
        expect(requested[0]).toContain(`/${EXAMPLES_REF}/`);
    });
});

describe('pinned canonical database guidance', () => {
    it('makes the release smoke inspect the installed deploy skill at the pinned ref', () => {
        expect(RELEASE_SMOKE).toContain('solidactions-deploy-and-config.md');
        expect(RELEASE_SMOKE).toContain('## Recipe — Databases');
    });
});

// ---------------------------------------------------------------------------
// Source guard for init's TEMPLATE_FILES loop, which cannot be driven in
// isolation (init() prompts, chdir's, and exits). Asserts the loop's
// fetchRawFile call passes a ref rather than relying on the `main` default.
// ---------------------------------------------------------------------------

describe('init TEMPLATE_FILES fetch', () => {
    it('passes EXAMPLES_REF to fetchRawFile', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../src/commands/init.ts'), 'utf8');

        expect(source).toContain('EXAMPLES_REF');
        // The fetch must name the ref argument; a bare 3-arg call falls back to main.
        const fetchCall = source.match(/fetchRawFile\([^;]*?\);/s);
        expect(fetchCall).not.toBeNull();
        expect(fetchCall![0]).toContain('EXAMPLES_REF');
    });
});

// `ai examples` walks the repo with listRepoContents + fetchRawFile. It is
// interactive and network-driven, so it is guarded at the source level like
// init's loop: every call in the file must carry the ref. The first pass at #86
// missed this file entirely.
describe('ai examples fetches', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/commands/ai-examples.ts'), 'utf8');

    it('pins every listRepoContents and fetchRawFile call to EXAMPLES_REF', () => {
        const calls = source.match(/(?:listRepoContents|fetchRawFile)\([^;]*?\)/gs) ?? [];
        // Guard the guard: if the calls are ever restructured away, fail loudly
        // rather than vacuously passing over an empty list.
        expect(calls.length).toBeGreaterThanOrEqual(3);
        for (const call of calls) {
            expect(call).toContain('EXAMPLES_REF');
        }
    });
});
