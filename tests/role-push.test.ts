/**
 * Tests for `solidactions role push <dir>`
 *
 * Uses a real in-process HTTP server (Node's http.createServer) to stub the
 * /mcp/crews endpoint. No mock/spy/stub libraries — follows the pattern in
 * skill-push.test.ts.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { rolePushWithConfig } from '../src/commands/role-push';
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

// Server state — a FIFO queue of canned responses; falls back to a default create-success.
const DEFAULT_RESPONSE = makeMcpSuccess({ role_doc_id: 1, folder_id: 2 });
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

/** Patch process.exit to throw ProcessExitError so tests can catch it. */
function patchProcessExit(): () => void {
    const orig = process.exit.bind(process);
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    return () => { (process as any).exit = orig; };
}

/** Patch process.stderr.write to capture output. */
function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => { lines.push(String(chunk)); return true; };
    return { lines, restore: () => { (process.stderr as any).write = orig; } };
}

/** Create a temp dir with a SKILL.md file. */
function makeTmpRoleDir(skillMdContent: string): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-role-test-'));
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMdContent, 'utf8');
    return {
        dir,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

// ---------------------------------------------------------------------------
// Core create test
// ---------------------------------------------------------------------------

describe('role push — create success', () => {
    it('posts to roles tool with action:create, sends correct args, NO references key, prints "created role", exits 0', async () => {
        responseQueue = [makeMcpSuccess({ role_doc_id: 1, folder_id: 2 })];

        const { dir, cleanup } = makeTmpRoleDir(
            [
                '---',
                'name: my-role',
                'description: A test role definition',
                '---',
                '',
                '## Role body',
            ].join('\n'),
        );

        const restoreExit = patchProcessExit();
        const logs: string[] = [];
        const origLog = console.log;
        console.log = (m?: any) => { logs.push(String(m)); };

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await rolePushWithConfig(dir, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            // Must exit 0
            expect(caughtExit?.code).toBe(0);

            // Exactly one HTTP call
            expect(allCaptures.length).toBe(1);
            expect(lastCapture).not.toBeNull();
            expect(lastCapture!.method).toBe('POST');
            expect(lastCapture!.path).toBe('/mcp/crews');

            // Auth headers
            expect(lastCapture!.headers['authorization']).toBe('Bearer test-api-key');

            // JSON-RPC shape: name must be 'roles', action must be 'create'
            const body = lastCapture!.body;
            expect(body.params.name).toBe('roles');
            expect(body.params.arguments.action).toBe('create');
            expect(body.params.arguments.name).toBe('my-role');
            expect(body.params.arguments.description).toBe('A test role definition');

            // Body content should be present
            expect(typeof body.params.arguments.body).toBe('string');

            // NO references key — roles carry no references
            expect(body.params.arguments).not.toHaveProperty('references');

            // Output must say "created role 'my-role'"
            expect(logs.join('')).toContain("created role 'my-role'");
        } finally {
            console.log = origLog;
            restoreExit();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Collision → edit (upsert)
// ---------------------------------------------------------------------------

describe('role push — collision → edit (upsert)', () => {
    it('on name_collision switches to roles.edit and reports "updated role", sends name + properties_patch, NO references', async () => {
        responseQueue = [
            makeMcpError('name_collision', 'A role with this name already exists.'),
            makeMcpSuccess({ version_id: 5, body_blob_sha: 'abc' }),
        ];

        const { dir, cleanup } = makeTmpRoleDir(
            [
                '---',
                'name: existing-role',
                'description: Updated description',
                'catalog_advertised: true',
                '---',
                'Updated body',
            ].join('\n'),
        );

        const restoreExit = patchProcessExit();
        const logs: string[] = [];
        const origLog = console.log;
        console.log = (m?: any) => { logs.push(String(m)); };

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await rolePushWithConfig(dir, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            // Exactly two HTTP calls
            expect(allCaptures.length).toBe(2);

            // First call: create
            expect(allCaptures[0].body.params.name).toBe('roles');
            expect(allCaptures[0].body.params.arguments.action).toBe('create');

            // Second call: edit
            const editArgs = allCaptures[1].body.params.arguments;
            expect(allCaptures[1].body.params.name).toBe('roles');
            expect(editArgs.action).toBe('edit');
            // roles edit uses 'name', NOT 'identifier'
            expect(editArgs.name).toBe('existing-role');
            // properties_patch must be present (not properties)
            expect(editArgs).toHaveProperty('properties_patch');
            // NO references key on roles edit
            expect(editArgs).not.toHaveProperty('references');

            // Output must say "updated role"
            expect(logs.join('')).toContain('updated role');
        } finally {
            console.log = origLog;
            restoreExit();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// --dry-run: role does NOT exist
// ---------------------------------------------------------------------------

describe('role push --dry-run — role does not exist', () => {
    it('pre-flight uses roles read with {action:read, name:<name>}, prints "[dry-run] would create", makes zero create/edit calls', async () => {
        // role_not_found is the error code from Roles.php handleRead when role is missing
        responseQueue = [makeMcpError('role_not_found', 'Role not found.')];

        const { dir, cleanup } = makeTmpRoleDir(
            [
                '---',
                'name: my-role',
                'description: A brand new role',
                '---',
                'role body',
            ].join('\n'),
        );

        const restoreExit = patchProcessExit();
        const logs: string[] = [];
        const origLog = console.log;
        console.log = (m?: any) => { logs.push(String(m)); };

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await rolePushWithConfig(dir, { dryRun: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            // Must exit 0
            expect(caughtExit?.code).toBe(0);

            // Exactly ONE HTTP call (the read pre-flight)
            expect(allCaptures.length).toBe(1);

            // Pre-flight uses action:read with name (NOT identifier)
            const preflightArgs = allCaptures[0].body.params.arguments;
            expect(allCaptures[0].body.params.name).toBe('roles');
            expect(preflightArgs.action).toBe('read');
            expect(preflightArgs.name).toBe('my-role');
            // Must NOT use 'identifier' param
            expect(preflightArgs).not.toHaveProperty('identifier');

            // Zero create or edit calls
            const hasCreate = allCaptures.some((c) => c.body.params.arguments.action === 'create');
            const hasEdit = allCaptures.some((c) => c.body.params.arguments.action === 'edit');
            expect(hasCreate).toBe(false);
            expect(hasEdit).toBe(false);

            // Output must say "[dry-run] would create 'my-role'"
            expect(logs.join('')).toContain("[dry-run] would create 'my-role'");
        } finally {
            console.log = origLog;
            restoreExit();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// --dry-run: role EXISTS
// ---------------------------------------------------------------------------

describe('role push --dry-run — role exists', () => {
    it('pre-flight read returns success → prints "[dry-run] would update", makes zero create/edit calls', async () => {
        // Read returns a role activation payload (success)
        responseQueue = [makeMcpSuccess({
            name: 'my-role',
            description: 'An existing role',
            body: 'existing body',
        })];

        const { dir, cleanup } = makeTmpRoleDir(
            [
                '---',
                'name: my-role',
                'description: Updated role description',
                '---',
                'updated body',
            ].join('\n'),
        );

        const restoreExit = patchProcessExit();
        const logs: string[] = [];
        const origLog = console.log;
        console.log = (m?: any) => { logs.push(String(m)); };

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await rolePushWithConfig(dir, { dryRun: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            // Must exit 0
            expect(caughtExit?.code).toBe(0);

            // Exactly ONE HTTP call (the read pre-flight)
            expect(allCaptures.length).toBe(1);
            expect(allCaptures[0].body.params.arguments.action).toBe('read');

            // Zero create or edit calls
            const hasCreate = allCaptures.some((c) => c.body.params.arguments.action === 'create');
            const hasEdit = allCaptures.some((c) => c.body.params.arguments.action === 'edit');
            expect(hasCreate).toBe(false);
            expect(hasEdit).toBe(false);

            // Output must say "[dry-run] would update 'my-role'"
            expect(logs.join('')).toContain("[dry-run] would update 'my-role'");
        } finally {
            console.log = origLog;
            restoreExit();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Missing SKILL.md → error + exit 1
// ---------------------------------------------------------------------------

describe('role push — missing SKILL.md', () => {
    it('exits non-zero with an error message when SKILL.md is missing, makes no HTTP requests', async () => {
        // Create an empty directory (no SKILL.md)
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-role-empty-'));

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await rolePushWithConfig(dir, {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            // No HTTP requests
            expect(lastCapture).toBeNull();

            // Must exit non-zero
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
});
