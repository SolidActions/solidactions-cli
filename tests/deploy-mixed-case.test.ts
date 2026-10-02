/**
 * Tests for `getProjectBySlugOrCanonical` (cli#102): a deploy lookup tries the
 * typed spelling first, then — on a 404 only — the canonical slug.
 *
 * Direct helper calls against a real in-process HTTP server that records
 * request paths. No mock/spy/stub libraries.
 */
import * as http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProjectBySlugOrCanonical } from '../src/commands/deploy';

let server: http.Server;
let port: number;
let seenPaths: string[] = [];

beforeAll(async () => {
    server = http.createServer((request, response) => {
        seenPaths.push(request.url ?? '');
        if (request.url === '/api/v1/projects/issue970-smoke-qxljve') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ slug: 'issue970-smoke-qxljve' }));
        } else if (request.url === '/api/v1/projects/legacy_slug') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ slug: 'legacy_slug' }));
        } else if (request.url === '/api/v1/projects/broken') {
            response.writeHead(500, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ message: 'boom' }));
        } else {
            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ message: 'Not found.' }));
        }
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
});

describe('getProjectBySlugOrCanonical (cli#102)', () => {
    const config = { host: '', apiKey: 'k', workspaceId: 'w' };

    beforeAll(() => {
        config.host = `http://127.0.0.1:${port}`;
    });

    it('retries a mixed-case miss by the canonical slug, typed path first', async () => {
        seenPaths = [];
        const res = await getProjectBySlugOrCanonical(config, 'issue970-smoke-QXlJVE', 'issue970-smoke-qxljve');
        expect(res.data.slug).toBe('issue970-smoke-qxljve');
        expect(seenPaths).toEqual([
            '/api/v1/projects/issue970-smoke-QXlJVE',
            '/api/v1/projects/issue970-smoke-qxljve',
        ]);
    });

    it('a legacy slug that resolves as typed costs one request', async () => {
        seenPaths = [];
        const res = await getProjectBySlugOrCanonical(config, 'legacy_slug', 'legacy-slug');
        expect(res.data.slug).toBe('legacy_slug');
        expect(seenPaths).toEqual(['/api/v1/projects/legacy_slug']);
    });

    it('a 404 on both spellings rejects with 404 after one request when they are equal', async () => {
        seenPaths = [];
        await expect(getProjectBySlugOrCanonical(config, 'nope', 'nope')).rejects.toMatchObject({
            response: { status: 404 },
        });
        expect(seenPaths).toEqual(['/api/v1/projects/nope']);
    });

    it('a non-404 failure is never retried', async () => {
        seenPaths = [];
        await expect(getProjectBySlugOrCanonical(config, 'broken', 'broken-x')).rejects.toMatchObject({
            response: { status: 500 },
        });
        expect(seenPaths).toEqual(['/api/v1/projects/broken']);
    });

    it('an empty canonical slug is never tried', async () => {
        seenPaths = [];
        await expect(getProjectBySlugOrCanonical(config, '!!!', '')).rejects.toMatchObject({
            response: { status: 404 },
        });
        expect(seenPaths).toEqual(['/api/v1/projects/!!!']);
    });
});
