/**
 * F-C7 — `solidactions project pull` round-trip.
 *
 * The server's GET /api/v1/projects/{slug}/source streams back the EXACT
 * bytes `deploy` uploaded — a gzip tar with a root-level `Dockerfile` and all
 * project source nested under a `tenantcode/` prefix (confirmed against
 * solidactions-app's ProjectApiController::downloadSource, which does a plain
 * Storage::download with no tar manipulation; deploy.ts:510-527 builds the
 * archive that shape). `pull` used to extract it verbatim, so a pulled
 * project's files landed one level too deep (under `tenantcode/`) alongside a
 * stray `Dockerfile` — the round-trip left junk the user never wrote. `pull`
 * must unwrap: strip the `tenantcode/` prefix and drop `Dockerfile` +
 * `sa-nocache-*` cache-buster entries (deploy.ts's noCache mechanism).
 *
 * Test-double policy: builds a real gzip tar fixture with the `archiver`
 * package (the same one deploy.ts uses to build the real upload), served by
 * a real in-process HTTP server (Node's http.createServer). No mock/spy/stub
 * libraries. makeTmpEnv/writeGlobal give a real tmp $HOME + config file.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import archiver from 'archiver';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { pull } from '../src/commands/pull';
import { makeTmpEnv, writeGlobal } from './helpers';

/** Build a gzip tar buffer mirroring deploy.ts's upload shape. */
function buildFixtureArchive(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const archive = archiver('tar', { gzip: true, gzipOptions: { level: 9 } });
        const chunks: Buffer[] = [];
        archive.on('data', (chunk) => chunks.push(chunk));
        archive.on('error', reject);
        archive.on('end', () => resolve(Buffer.concat(chunks)));

        archive.append('FROM node:20-slim\nCOPY tenantcode/ .\n', { name: 'Dockerfile' });
        archive.append(JSON.stringify({ name: 'demo' }, null, 2), { name: 'tenantcode/package.json' });
        archive.append('export const hello = () => "hi";\n', { name: 'tenantcode/src/hello.ts' });
        archive.append('force-rebuild abc123 0', { name: 'tenantcode/sa-nocache-abc123' });
        archive.finalize();
    });
}

let stubServer: http.Server;
let stubPort: number;
let fixtureArchive: Buffer;

beforeAll(async () => {
    fixtureArchive = await buildFixtureArchive();

    stubServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(fixtureArchive);
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

describe('project pull — unwraps the server build archive', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let originalExit: typeof process.exit;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${stubPort}`,
            apiKey: 'test-key',
            workspaceId: 'ws-1',
        });
        originalExit = process.exit;
        (process as any).exit = (code?: number) => { throw new Error(`process.exit(${code})`); };
    });

    afterEach(() => {
        process.exit = originalExit;
        env.cleanup();
    });

    it('places project files at dest root and drops Dockerfile, tenantcode/, and sa-nocache-* entries', async () => {
        const dest = path.join(env.cwd, 'pulled-project');

        await pull('demo', dest, { yes: true });

        expect(fs.existsSync(path.join(dest, 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'src', 'hello.ts'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'Dockerfile'))).toBe(false);
        expect(fs.existsSync(path.join(dest, 'tenantcode'))).toBe(false);
        expect(fs.existsSync(path.join(dest, 'sa-nocache-abc123'))).toBe(false);

        const content = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
        expect(content.name).toBe('demo');
    }, 20_000);
});
