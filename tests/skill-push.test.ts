/**
 * Tests for `solidactions skill push <dir>`
 *
 * Uses a real in-process HTTP server (Node's http.createServer) to stub the
 * /mcp/crews endpoint.  No mock/spy/stub libraries — follows the pattern in
 * dev.test.ts and proxy-contract.test.ts.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { parseSkillFile, readReferences, skillPushWithConfig, pushParsedSkill } from '../src/commands/skill-push';
import type { SkillPushOptions } from '../src/commands/skill-push';
import type { Config } from '../src/utils/config';

// ---------------------------------------------------------------------------
// Stub MCP server — records the last request and returns a canned response
// ---------------------------------------------------------------------------

interface CapturedRequest {
    method: string | undefined;
    path: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: any;
}

let stubServer: http.Server;
let stubPort: number;
let lastCapture: CapturedRequest | null = null;
let allCaptures: CapturedRequest[] = [];

/** Canned MCP success response for a skill create. */
function makeMcpSuccess(toolData: object): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
            isError: false,
            content: [{ type: 'text', text: JSON.stringify(toolData) }],
        },
    });
}

/** Canned MCP error response (isError: true). */
function makeMcpError(code: string, message: string): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
        },
    });
}

// Server state — a FIFO queue of canned responses; falls back to a default create-success.
const DEFAULT_RESPONSE = makeMcpSuccess({ skill_doc_id: 'doc-abc123', reference_doc_ids: {} });
let responseQueue: string[] = [];

function nextResponseBody(): string {
    return responseQueue.length > 0 ? responseQueue.shift()! : DEFAULT_RESPONSE;
}

beforeAll(async () => {
    stubServer = http.createServer((req, res) => {
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
            let parsedBody: any = null;
            try { parsedBody = JSON.parse(rawBody); } catch { /* ignore */ }

            const capture: CapturedRequest = {
                method: req.method,
                path: req.url,
                headers: req.headers,
                body: parsedBody,
            };

            lastCapture = capture;
            allCaptures.push(capture);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(nextResponseBody());
        });
    });

    await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', () => {
            stubPort = (stubServer.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        stubServer.close((err) => (err ? reject(err) : resolve()));
    });
});

beforeEach(() => {
    lastCapture = null;
    allCaptures = [];
    responseQueue = [];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Config that points at the stub server. */
function stubConfig(workspaceId = 'ws-test-uuid'): Config {
    return {
        host: `http://127.0.0.1:${stubPort}`,
        apiKey: 'test-api-key',
        workspaceId,
    };
}

/** Sentinel thrown by the patched process.exit so execution stops. */
class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

/**
 * Patch process.exit to throw ProcessExitError so tests can catch it.
 * Returns a function that restores the original process.exit.
 */
function patchProcessExit(): () => void {
    const orig = process.exit.bind(process);
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    return () => { (process as any).exit = orig; };
}

/**
 * Patch process.stderr.write to capture output.
 * Returns captured lines and a restore function.
 */
function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => { lines.push(String(chunk)); return true; };
    return { lines, restore: () => { (process.stderr as any).write = orig; } };
}

/** Create a temp dir with a SKILL.md and optional sibling files. */
function makeTmpSkillDir(skillMdContent: string, siblings: Record<string, string> = {}): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-crews-test-'));

    fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMdContent, 'utf8');
    for (const [name, content] of Object.entries(siblings)) {
        fs.writeFileSync(path.join(dir, name), content, 'utf8');
    }

    return {
        dir,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

// ---------------------------------------------------------------------------
// Unit tests: parseSkillFile
// ---------------------------------------------------------------------------

describe('parseSkillFile', () => {
    it('parses name, description, body, and remaining frontmatter properties', () => {
        const content = [
            '---',
            'name: My Skill',
            'description: Does something useful',
            'catalog_advertised: true',
            '---',
            '',
            'This is the body.',
        ].join('\n');

        const result = parseSkillFile(content);

        expect(result.name).toBe('My Skill');
        expect(result.description).toBe('Does something useful');
        // The empty line after the closing --- is preserved as part of the body
        expect(result.body).toContain('This is the body.');
        // catalog_advertised passes through into properties
        expect(result.properties).toEqual({ catalog_advertised: true });
        // name and description must NOT appear in properties
        expect(result.properties).not.toHaveProperty('name');
        expect(result.properties).not.toHaveProperty('description');
    });

    it('does not include "type" in properties (server sets it)', () => {
        const content = [
            '---',
            'name: Typed Skill',
            'description: A skill with a type field',
            'type: custom_type',
            '---',
            'body text',
        ].join('\n');

        const result = parseSkillFile(content);
        expect(result.properties).not.toHaveProperty('type');
    });

    it('catalog_advertised true passes through into properties and is not treated as name/description', () => {
        const content = [
            '---',
            'name: Advertised Skill',
            'description: Shown in catalog',
            'catalog_advertised: true',
            '---',
            'body',
        ].join('\n');

        const result = parseSkillFile(content);
        expect(result.properties.catalog_advertised).toBe(true);
        expect(result.name).toBe('Advertised Skill');
    });

    it('throws when frontmatter opening marker is missing', () => {
        expect(() => parseSkillFile('name: foo\ndescription: bar\nbody')).toThrow(/must begin with a YAML frontmatter/);
    });

    it('throws when frontmatter closing marker is missing', () => {
        expect(() => parseSkillFile('---\nname: foo\ndescription: bar\nbody')).toThrow(/not closed/);
    });

    it('throws when "name" is missing from frontmatter', () => {
        const content = '---\ndescription: A description\n---\nbody';
        expect(() => parseSkillFile(content)).toThrow(/"name"/);
    });

    it('throws when "description" is missing from frontmatter', () => {
        const content = '---\nname: My Skill\n---\nbody';
        expect(() => parseSkillFile(content)).toThrow(/"description"/);
    });
});

// ---------------------------------------------------------------------------
// Unit tests: readReferences
// ---------------------------------------------------------------------------

describe('readReferences', () => {
    it('reads top-level files and excludes SKILL.md', () => {
        const { dir, cleanup } = makeTmpSkillDir(
            '---\nname: S\ndescription: D\n---\nbody',
            {
                'example.ts': 'const x = 1;',
                'notes.txt': 'some notes',
            },
        );

        try {
            const refs = readReferences(dir);
            expect(refs).toEqual({
                'example.ts': 'const x = 1;',
                'notes.txt': 'some notes',
            });
            expect(refs).not.toHaveProperty('SKILL.md');
        } finally {
            cleanup();
        }
    });

    it('recurses into subdirectories, keyed by relative path', () => {
        const { dir, cleanup } = makeTmpSkillDir(
            '---\nname: S\ndescription: D\n---\nbody',
            { 'top.ts': 'top' },
        );

        try {
            // Create a nested subdirectory with a file
            const sub = path.join(dir, 'subdir');
            fs.mkdirSync(sub);
            fs.writeFileSync(path.join(sub, 'nested.ts'), 'nested', 'utf8');

            const refs = readReferences(dir);
            expect(refs).toHaveProperty('top.ts', 'top');
            // nested file is included, keyed by its POSIX relative path
            expect(refs).toHaveProperty('subdir/nested.ts', 'nested');
        } finally {
            cleanup();
        }
    });

    it('recurses into a references/ subfolder, keyed by path relative to the skill dir (#247)', () => {
        const { dir, cleanup } = makeTmpSkillDir(
            '---\nname: S\ndescription: D\n---\nbody references references/member-roles.md',
            { 'top.md': 'top content' },
        );

        try {
            const sub = path.join(dir, 'references');
            fs.mkdirSync(sub);
            fs.writeFileSync(path.join(sub, 'member-roles.md'), 'roles content', 'utf8');

            const refs = readReferences(dir);
            // top-level files keep bare-filename keys (backward compatible)
            expect(refs).toHaveProperty('top.md', 'top content');
            // subfolder files are keyed by their POSIX path relative to the skill dir,
            // matching how SKILL.md cites them (references/member-roles.md)
            expect(refs).toHaveProperty('references/member-roles.md', 'roles content');
            expect(refs).not.toHaveProperty('SKILL.md');
        } finally {
            cleanup();
        }
    });

    it('returns empty object when no sibling files exist', () => {
        const { dir, cleanup } = makeTmpSkillDir('---\nname: S\ndescription: D\n---\nbody');

        try {
            const refs = readReferences(dir);
            expect(refs).toEqual({});
        } finally {
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Integration tests: skillPushWithConfig — HTTP request shape
// ---------------------------------------------------------------------------

describe('skillPushWithConfig — shared library (no --role)', () => {
    it('posts tools/call with name:skills and action:create, sends X-Workspace-Id header', async () => {
        const { dir, cleanup } = makeTmpSkillDir(
            [
                '---',
                'name: My Cool Skill',
                'description: Does cool things',
                'catalog_advertised: false',
                '---',
                '',
                '## Usage\n\nCall this skill to do cool things.',
            ].join('\n'),
            { 'usage.ts': 'export const usage = "example";' },
        );

        const restoreExit = patchProcessExit();

        try {
            const config = stubConfig('ws-123');
            const options: SkillPushOptions = {};

            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPushWithConfig(dir, options, config);
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            // Should have exited cleanly (code 0)
            expect(caughtExit?.code).toBe(0);

            // Assert HTTP request was made
            expect(lastCapture).not.toBeNull();
            expect(lastCapture!.method).toBe('POST');
            expect(lastCapture!.path).toBe('/mcp/crews');

            // Assert X-Workspace-Id header
            expect(lastCapture!.headers['x-workspace-id']).toBe('ws-123');

            // Assert Authorization header
            expect(lastCapture!.headers['authorization']).toBe('Bearer test-api-key');

            // Assert JSON-RPC body shape
            const body = lastCapture!.body;
            expect(body.jsonrpc).toBe('2.0');
            expect(body.method).toBe('tools/call');
            expect(body.params.name).toBe('skills');
            expect(body.params.arguments.action).toBe('create');
            expect(body.params.arguments.name).toBe('My Cool Skill');
            expect(body.params.arguments.description).toBe('Does cool things');

            // catalog_advertised should be in properties
            expect(body.params.arguments.properties).toMatchObject({ catalog_advertised: false });

            // references should include the sibling file
            expect(body.params.arguments.references).toHaveProperty('usage.ts', 'export const usage = "example";');

            // SKILL.md should NOT be in references
            expect(body.params.arguments.references).not.toHaveProperty('SKILL.md');
        } finally {
            restoreExit();
            cleanup();
        }
    });
});

describe('skillPushWithConfig — with --role', () => {
    it('posts tools/call with name:roles and action:create_skill, includes role in arguments', async () => {
        const { dir, cleanup } = makeTmpSkillDir(
            [
                '---',
                'name: Role Skill',
                'description: A skill for a specific role',
                '---',
                'body content',
            ].join('\n'),
        );

        const restoreExit = patchProcessExit();

        try {
            const config = stubConfig('ws-456');
            const options: SkillPushOptions = { role: 'senior-engineer' };

            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPushWithConfig(dir, options, config);
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(lastCapture).not.toBeNull();

            const body = lastCapture!.body;
            expect(body.params.name).toBe('roles');
            expect(body.params.arguments.action).toBe('create_skill');
            expect(body.params.arguments.role).toBe('senior-engineer');
            expect(body.params.arguments.name).toBe('Role Skill');
            expect(body.params.arguments.description).toBe('A skill for a specific role');
            expect(body.params.arguments.references).toEqual({});
        } finally {
            restoreExit();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('skillPushWithConfig — error cases', () => {
    it('exits non-zero without making any HTTP request when SKILL.md is missing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-crews-test-empty-'));

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const config = stubConfig();
            const options: SkillPushOptions = {};

            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPushWithConfig(dir, options, config);
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            // No HTTP request should have been made
            expect(lastCapture).toBeNull();

            // Should have exited with non-zero
            expect(caughtExit).not.toBeNull();
            expect(caughtExit!.code).not.toBe(0);

            // Error message should mention SKILL.md
            expect(stderrLines.join('')).toMatch(/SKILL\.md/);
        } finally {
            restoreExit();
            restoreStderr();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('surfaces a non-collision MCP error code and message and exits non-zero', async () => {
        responseQueue = [makeMcpError('validation_failed', 'name must be kebab-case.')];

        const { dir, cleanup } = makeTmpSkillDir(
            ['---', 'name: Bad Skill', 'description: nope', '---', 'body'].join('\n'),
        );

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPushWithConfig(dir, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e; else throw e;
            }
            expect(caughtExit!.code).not.toBe(0);
            const out = stderrLines.join('');
            expect(out).toContain('validation_failed');
            expect(out).toContain('name must be kebab-case.');
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Upsert tests
// ---------------------------------------------------------------------------

describe('skillPushWithConfig — idempotent upsert', () => {
    it('on name_collision for a shared skill, switches to skills.edit and reports "updated"', async () => {
        responseQueue = [
            makeMcpError('name_collision', 'A skill with this name already exists.'),
            makeMcpSuccess({ version_id: 42, body_blob_sha: 'deadbeef' }),
        ];
        const { dir, cleanup } = makeTmpSkillDir(
            ['---', 'name: Existing Skill', 'description: updated desc', '---', 'new body'].join('\n'),
            { 'ref.ts': 'export const x = 1;' },
        );
        const restoreExit = patchProcessExit();
        const logs: string[] = [];
        const origLog = console.log;
        console.log = (m?: any) => { logs.push(String(m)); };
        try {
            let caughtExit: ProcessExitError | null = null;
            try { await skillPushWithConfig(dir, {}, stubConfig()); }
            catch (e) { if (e instanceof ProcessExitError) caughtExit = e; else throw e; }
            expect(caughtExit?.code).toBe(0);
            expect(allCaptures.length).toBe(2);
            expect(allCaptures[0].body.params.arguments.action).toBe('create');
            expect(allCaptures[1].body.params.name).toBe('skills');
            expect(allCaptures[1].body.params.arguments.action).toBe('edit');
            expect(allCaptures[1].body.params.arguments.identifier).toBe('Existing Skill');
            expect(allCaptures[1].body.params.arguments).toHaveProperty('properties_patch');
            expect(allCaptures[1].body.params.arguments.references).toHaveProperty('ref.ts');
            expect(logs.join('')).toContain('updated skill');
        } finally { console.log = origLog; restoreExit(); cleanup(); }
    });

    it('on name_collision for a role skill, switches to roles.edit_skill and reports "updated"', async () => {
        responseQueue = [
            makeMcpError('name_collision', 'exists'),
            makeMcpSuccess({ version_id: 7, body_blob_sha: 'cafe' }),
        ];
        const { dir, cleanup } = makeTmpSkillDir(
            ['---', 'name: Role Skill', 'description: d', '---', 'body'].join('\n'),
        );
        const restoreExit = patchProcessExit();
        const logs: string[] = [];
        const origLog = console.log;
        console.log = (m?: any) => { logs.push(String(m)); };
        try {
            let caughtExit: ProcessExitError | null = null;
            try { await skillPushWithConfig(dir, { role: 'builder' }, stubConfig()); }
            catch (e) { if (e instanceof ProcessExitError) caughtExit = e; else throw e; }
            expect(caughtExit?.code).toBe(0);
            expect(allCaptures.length).toBe(2);
            expect(allCaptures[1].body.params.name).toBe('roles');
            expect(allCaptures[1].body.params.arguments.action).toBe('edit_skill');
            expect(allCaptures[1].body.params.arguments.role).toBe('builder');
            expect(allCaptures[1].body.params.arguments.name).toBe('Role Skill');
            expect(logs.join('')).toContain('updated skill');
        } finally { console.log = origLog; restoreExit(); cleanup(); }
    });

    it('creates (single call) and reports "created" when no collision', async () => {
        responseQueue = [makeMcpSuccess({ skill_doc_id: 'doc-9', reference_doc_ids: { 'a.ts': 1 } })];
        const { dir, cleanup } = makeTmpSkillDir(
            ['---', 'name: Fresh', 'description: d', '---', 'body'].join('\n'),
            { 'a.ts': 'x' },
        );
        const restoreExit = patchProcessExit();
        const logs: string[] = [];
        const origLog = console.log;
        console.log = (m?: any) => { logs.push(String(m)); };
        try {
            let caughtExit: ProcessExitError | null = null;
            try { await skillPushWithConfig(dir, {}, stubConfig()); }
            catch (e) { if (e instanceof ProcessExitError) caughtExit = e; else throw e; }
            expect(caughtExit?.code).toBe(0);
            expect(allCaptures.length).toBe(1);
            expect(logs.join('')).toContain('created skill');
            expect(logs.join('')).toContain('1 refs');
        } finally { console.log = origLog; restoreExit(); cleanup(); }
    });
});

// ---------------------------------------------------------------------------
// pushParsedSkill — core unit (no process.exit, no print, returns result)
// ---------------------------------------------------------------------------

describe('pushParsedSkill — core payload-based upsert', () => {
    const basePayload = {
        name: 'Core Skill',
        description: 'A payload-based skill',
        properties: { catalog_advertised: true },
        body: 'The skill body',
        references: { 'helper.ts': 'export const x = 1;' },
    };

    it('sends skills.create and returns {status:"created", name, data} without calling process.exit', async () => {
        const createData = { skill_doc_id: 'doc-core-1', reference_doc_ids: { 'helper.ts': 99 } };
        responseQueue = [makeMcpSuccess(createData)];

        const restoreExit = patchProcessExit();
        try {
            // pushParsedSkill must NOT throw ProcessExitError — if it calls process.exit this will throw
            const result = await pushParsedSkill(basePayload, {}, stubConfig());

            expect(result.status).toBe('created');
            expect(result.name).toBe('Core Skill');
            expect(result.data).toMatchObject(createData);

            // Verify HTTP request shape
            expect(allCaptures.length).toBe(1);
            const args = allCaptures[0].body.params.arguments;
            expect(allCaptures[0].body.params.name).toBe('skills');
            expect(args.action).toBe('create');
            expect(args.name).toBe('Core Skill');
            expect(args.description).toBe('A payload-based skill');
            expect(args.properties).toMatchObject({ catalog_advertised: true });
            expect(args.references).toHaveProperty('helper.ts', 'export const x = 1;');
            expect(args.body).toBe('The skill body');
        } finally {
            restoreExit();
        }
    });

    it('on name_collision switches to skills.edit and returns {status:"updated", name, data}', async () => {
        const editData = { version_id: 55, body_blob_sha: 'abcdef' };
        responseQueue = [
            makeMcpError('name_collision', 'A skill with this name already exists.'),
            makeMcpSuccess(editData),
        ];

        const restoreExit = patchProcessExit();
        try {
            const result = await pushParsedSkill(basePayload, {}, stubConfig());

            expect(result.status).toBe('updated');
            expect(result.name).toBe('Core Skill');
            expect(result.data).toMatchObject(editData);

            // Two HTTP requests: first create, then edit on collision
            expect(allCaptures.length).toBe(2);

            // First request: create
            expect(allCaptures[0].body.params.arguments.action).toBe('create');

            // Second request: edit with correct args
            const editArgs = allCaptures[1].body.params.arguments;
            expect(allCaptures[1].body.params.name).toBe('skills');
            expect(editArgs.action).toBe('edit');
            expect(editArgs.identifier).toBe('Core Skill');
            expect(editArgs.description).toBe('A payload-based skill');
            expect(editArgs).toHaveProperty('properties_patch');
            expect(editArgs.properties_patch).toMatchObject({ catalog_advertised: true });
            expect(editArgs.references).toHaveProperty('helper.ts');
        } finally {
            restoreExit();
        }
    });

    it('on name_collision with --role switches to roles.edit_skill and returns {status:"updated"}', async () => {
        const editData = { version_id: 3, body_blob_sha: 'cafebabe' };
        responseQueue = [
            makeMcpError('name_collision', 'exists'),
            makeMcpSuccess(editData),
        ];

        const restoreExit = patchProcessExit();
        try {
            const result = await pushParsedSkill(basePayload, { role: 'senior-dev' }, stubConfig());

            expect(result.status).toBe('updated');

            expect(allCaptures.length).toBe(2);
            // First: roles.create_skill
            expect(allCaptures[0].body.params.name).toBe('roles');
            expect(allCaptures[0].body.params.arguments.action).toBe('create_skill');
            expect(allCaptures[0].body.params.arguments.role).toBe('senior-dev');

            // Second: roles.edit_skill
            expect(allCaptures[1].body.params.name).toBe('roles');
            expect(allCaptures[1].body.params.arguments.action).toBe('edit_skill');
            expect(allCaptures[1].body.params.arguments.role).toBe('senior-dev');
            expect(allCaptures[1].body.params.arguments.name).toBe('Core Skill');
        } finally {
            restoreExit();
        }
    });

    it('throws on a non-collision MCP error without calling process.exit', async () => {
        responseQueue = [makeMcpError('validation_failed', 'name must be kebab-case.')];

        const restoreExit = patchProcessExit();
        try {
            // Must throw an Error (not ProcessExitError), propagating the MCP error
            await expect(pushParsedSkill(basePayload, {}, stubConfig())).rejects.toThrow('validation_failed');
        } finally {
            restoreExit();
        }
    });

    it('does not call process.exit even when it returns a result', async () => {
        responseQueue = [makeMcpSuccess({ skill_doc_id: 'doc-noexit', reference_doc_ids: {} })];

        // patchProcessExit so that ANY call to process.exit throws ProcessExitError
        const restoreExit = patchProcessExit();
        try {
            // If pushParsedSkill calls process.exit, this will throw ProcessExitError instead of resolving
            const result = await pushParsedSkill(basePayload, {}, stubConfig());
            // Reaching here means process.exit was NOT called
            expect(result.status).toBe('created');
        } finally {
            restoreExit();
        }
    });
});
