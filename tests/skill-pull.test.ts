/**
 * Tests for `solidactions skill pull <name> [dest]`
 *
 * Uses a real in-process HTTP server (Node's http.createServer) to stub the
 * /mcp/crews endpoint. No mock/spy/stub libraries — same pattern as skill-push.test.ts.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { parseSkillFile } from '../src/commands/skill-push';
import { skillPullWithConfig } from '../src/commands/skill-pull';
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

/** Canned MCP success response. */
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

// Server state — a FIFO queue of canned responses
let responseQueue: string[] = [];

function nextResponseBody(): string {
    return responseQueue.length > 0 ? responseQueue.shift()! : makeMcpSuccess({});
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

// ---------------------------------------------------------------------------
// Integration tests: skillPullWithConfig
// ---------------------------------------------------------------------------

describe('skill pull — happy path: writes SKILL.md + reference files', () => {
    it('sends action=read identifier=foo, writes SKILL.md with correct frontmatter (no type), and writes reference files', async () => {
        // Queue a success response from the server
        responseQueue = [
            makeMcpSuccess({
                identifier: 'foo',
                doc_id: 1,
                properties: {
                    name: 'foo',
                    description: 'A foo skill',
                    type: 'skill',           // must be OMITTED from written frontmatter
                    catalog_advertised: true,
                },
                body: '# Foo\n\nbody',
                reference: {
                    'references/a.md': 'A content',
                    'b.txt': 'B',
                },
            }),
        ];

        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-test-'));
        const restoreExit = patchProcessExit();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPullWithConfig('foo', dest, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            // Should have exited cleanly (code 0)
            expect(caughtExit?.code).toBe(0);

            // Assert exactly one HTTP request was made
            expect(allCaptures.length).toBe(1);
            expect(lastCapture).not.toBeNull();
            expect(lastCapture!.method).toBe('POST');

            // Assert request sent action=read + identifier=foo
            const args = lastCapture!.body.params.arguments;
            expect(args.action).toBe('read');
            expect(args.identifier).toBe('foo');

            // Assert SKILL.md was written
            const skillMdPath = path.join(dest, 'SKILL.md');
            expect(fs.existsSync(skillMdPath)).toBe(true);

            const skillMdContent = fs.readFileSync(skillMdPath, 'utf8');

            // Parse the written SKILL.md using parseSkillFile to validate structure
            const parsed = parseSkillFile(skillMdContent);
            expect(parsed.name).toBe('foo');
            expect(parsed.description).toBe('A foo skill');
            expect(parsed.properties.catalog_advertised).toBe(true);

            // CRITICAL: 'type' must NOT appear in the frontmatter
            expect(parsed.properties).not.toHaveProperty('type');
            expect(skillMdContent).not.toMatch(/^type:/m);

            // Body is preserved
            expect(skillMdContent).toContain('# Foo');
            expect(skillMdContent).toContain('body');

            // Assert reference files were written
            const refA = path.join(dest, 'references', 'a.md');
            expect(fs.existsSync(refA)).toBe(true);
            expect(fs.readFileSync(refA, 'utf8')).toBe('A content');

            const refB = path.join(dest, 'b.txt');
            expect(fs.existsSync(refB)).toBe(true);
            expect(fs.readFileSync(refB, 'utf8')).toBe('B');
        } finally {
            restoreExit();
            fs.rmSync(dest, { recursive: true, force: true });
        }
    });
});

describe('skill pull — round-trip: parse written SKILL.md back with parseSkillFile', () => {
    it('written SKILL.md round-trips through parseSkillFile with no type field', async () => {
        responseQueue = [
            makeMcpSuccess({
                identifier: 'my-skill',
                doc_id: 42,
                properties: {
                    name: 'my-skill',
                    description: 'My skill description',
                    type: 'skill',
                    catalog_advertised: false,
                    extra_field: 'extra_value',
                },
                body: 'The skill body content.',
                reference: {},
            }),
        ];

        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-rt-'));
        const restoreExit = patchProcessExit();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPullWithConfig('my-skill', dest, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const skillMdPath = path.join(dest, 'SKILL.md');
            const content = fs.readFileSync(skillMdPath, 'utf8');

            // Round-trip: parse with parseSkillFile (the same function skill push uses)
            const parsed = parseSkillFile(content);

            expect(parsed.name).toBe('my-skill');
            expect(parsed.description).toBe('My skill description');
            // type must NOT be in properties — idempotent push→pull→push round-trip
            expect(parsed.properties).not.toHaveProperty('type');
            expect(parsed.properties.catalog_advertised).toBe(false);
            expect(parsed.properties.extra_field).toBe('extra_value');
            expect(parsed.body).toContain('The skill body content.');
        } finally {
            restoreExit();
            fs.rmSync(dest, { recursive: true, force: true });
        }
    });
});

describe('skill pull — path traversal guard', () => {
    it('skips a reference key with ".." path traversal and does NOT write outside dest', async () => {
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-trav-'));

        // Compute the traversal target that ../evil.md would resolve to
        const traversalTarget = path.resolve(dest, '../evil.md');

        responseQueue = [
            makeMcpSuccess({
                identifier: 'trav-skill',
                doc_id: 10,
                properties: {
                    name: 'trav-skill',
                    description: 'Traversal test',
                    type: 'skill',
                },
                body: 'body',
                reference: {
                    '../evil.md': 'EVIL CONTENT',  // must be skipped
                    'safe.txt': 'SAFE CONTENT',     // must be written
                },
            }),
        ];

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPullWithConfig('trav-skill', dest, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            // The traversal file must NOT have been written outside dest
            expect(fs.existsSync(traversalTarget)).toBe(false);

            // The safe file IS written
            expect(fs.existsSync(path.join(dest, 'safe.txt'))).toBe(true);
            expect(fs.readFileSync(path.join(dest, 'safe.txt'), 'utf8')).toBe('SAFE CONTENT');

            // A warning was emitted to stderr about the skipped key
            const stderrOutput = stderrLines.join('');
            expect(stderrOutput).toMatch(/skip|traversal|unsafe/i);
        } finally {
            restoreExit();
            restoreStderr();
            fs.rmSync(dest, { recursive: true, force: true });
        }
    });

    it('skips an absolute path reference key and does NOT write to that path', async () => {
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-abs-'));
        const absoluteTarget = '/tmp/sa-pull-absolute-evil.txt';

        // Clean up in case it already exists from a previous failed test
        if (fs.existsSync(absoluteTarget)) {
            fs.unlinkSync(absoluteTarget);
        }

        responseQueue = [
            makeMcpSuccess({
                identifier: 'abs-skill',
                doc_id: 11,
                properties: {
                    name: 'abs-skill',
                    description: 'Absolute path test',
                    type: 'skill',
                },
                body: 'body',
                reference: {
                    '/tmp/sa-pull-absolute-evil.txt': 'EVIL',  // must be skipped
                    'safe-abs.txt': 'SAFE',
                },
            }),
        ];

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPullWithConfig('abs-skill', dest, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            // Absolute path must NOT have been written
            expect(fs.existsSync(absoluteTarget)).toBe(false);

            // Safe file IS written
            expect(fs.existsSync(path.join(dest, 'safe-abs.txt'))).toBe(true);

            // Warning was emitted
            const stderrOutput = stderrLines.join('');
            expect(stderrOutput).toMatch(/skip|traversal|unsafe/i);
        } finally {
            restoreExit();
            restoreStderr();
            fs.rmSync(dest, { recursive: true, force: true });
            if (fs.existsSync(absoluteTarget)) {
                fs.unlinkSync(absoluteTarget);
            }
        }
    });
});

describe('skill pull — error cases', () => {
    it('skill_not_found → prints error to stderr, exits non-zero, no files written', async () => {
        responseQueue = [makeMcpError('skill_not_found', 'No skill with that identifier exists.')];

        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-err-'));
        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPullWithConfig('nonexistent', dest, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            // Must exit non-zero
            expect(caughtExit).not.toBeNull();
            expect(caughtExit!.code).not.toBe(0);

            // Error message must mention the error code
            const stderrOutput = stderrLines.join('');
            expect(stderrOutput).toContain('skill_not_found');

            // SKILL.md must NOT have been written
            expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(false);
        } finally {
            restoreExit();
            restoreStderr();
            fs.rmSync(dest, { recursive: true, force: true });
        }
    });

    it('invalid_identifier_form → prints error to stderr, exits non-zero, no files written', async () => {
        responseQueue = [makeMcpError('invalid_identifier_form', 'Identifier must be kebab-case.')];

        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-inv-'));
        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPullWithConfig('Bad Name', dest, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit).not.toBeNull();
            expect(caughtExit!.code).not.toBe(0);

            const stderrOutput = stderrLines.join('');
            expect(stderrOutput).toContain('invalid_identifier_form');

            // SKILL.md must NOT have been written
            expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(false);
        } finally {
            restoreExit();
            restoreStderr();
            fs.rmSync(dest, { recursive: true, force: true });
        }
    });
});

describe('skill pull — default dest uses ./<name>/', () => {
    it('writes files to ./<name>/ when dest is not provided', async () => {
        responseQueue = [
            makeMcpSuccess({
                identifier: 'default-dest-skill',
                doc_id: 99,
                properties: {
                    name: 'default-dest-skill',
                    description: 'Test default dest',
                    type: 'skill',
                },
                body: 'body',
                reference: {},
            }),
        ];

        // Use a temp dir as the effective cwd simulation by providing no dest —
        // but we pass an explicit dest here to keep the test hermetic.
        // The real "default dest" logic is ./<name>/ relative to cwd.
        // We test it by passing undefined as dest.
        const originalCwd = process.cwd();
        const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-defcwd-'));
        process.chdir(tmpCwd);

        const restoreExit = patchProcessExit();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                // Pass undefined as dest — should default to ./default-dest-skill/
                await skillPullWithConfig('default-dest-skill', undefined, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const expectedSkillMd = path.join(tmpCwd, 'default-dest-skill', 'SKILL.md');
            expect(fs.existsSync(expectedSkillMd)).toBe(true);
        } finally {
            restoreExit();
            process.chdir(originalCwd);
            fs.rmSync(tmpCwd, { recursive: true, force: true });
        }
    });
});

describe('skill pull — provenance sidecar', () => {
    it('writes .solidactions-skill.json with identifier, doc_id, head_revision_id, and role:null', async () => {
        responseQueue = [
            makeMcpSuccess({
                identifier: 'my-skill',
                doc_id: 42,
                head_revision_id: 716,
                properties: {
                    name: 'my-skill',
                    description: 'My skill description',
                    type: 'skill',
                },
                body: 'The skill body content.',
                reference: {},
            }),
        ];

        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-sidecar-'));
        const restoreExit = patchProcessExit();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPullWithConfig('my-skill', dest, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const sidecarPath = path.join(dest, '.solidactions-skill.json');
            expect(fs.existsSync(sidecarPath)).toBe(true);

            const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
            expect(sidecar).toEqual({
                identifier: 'my-skill',
                doc_id: 42,
                head_revision_id: 716,
                role: null,
            });
        } finally {
            restoreExit();
            fs.rmSync(dest, { recursive: true, force: true });
        }
    });
});

describe('skill pull — --json flag', () => {
    it('--json prints raw read result to stdout and does NOT write files', async () => {
        const rawData = {
            identifier: 'json-skill',
            doc_id: 77,
            properties: { name: 'json-skill', description: 'desc', type: 'skill' },
            body: 'body text',
            reference: { 'ref.md': 'ref content' },
        };
        responseQueue = [makeMcpSuccess(rawData)];

        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-json-'));
        const restoreExit = patchProcessExit();

        const logs: string[] = [];
        const origLog = console.log;
        console.log = (m?: any) => { logs.push(String(m)); };

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillPullWithConfig('json-skill', dest, { json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            // Raw JSON was printed to stdout
            const output = logs.join('');
            const parsed = JSON.parse(output);
            expect(parsed.identifier).toBe('json-skill');
            expect(parsed.properties.name).toBe('json-skill');

            // Files must NOT have been written (--json mode skips file writes)
            expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(false);
        } finally {
            console.log = origLog;
            restoreExit();
            fs.rmSync(dest, { recursive: true, force: true });
        }
    });
});
