/**
 * Task 4 (cli#161): `projectSlugCandidates` pure cases and `resolveProjectSlug`
 * against a real in-process HTTP server that records request paths.
 * No mock/spy/stub libraries.
 */
import * as http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchProjectRungs, projectSlugCandidates, resolveProjectSlug } from '../src/utils/project-ref';

let server: http.Server;
let port: number;
let seenPaths: string[] = [];

beforeAll(async () => {
    server = http.createServer((request, response) => {
        seenPaths.push(request.url ?? '');
        const json = (status: number, body: unknown) => {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(body));
        };
        if (request.url === '/api/v1/projects/typed-hit') {
            json(200, { slug: 'typed-hit' });
        } else if (request.url === '/api/v1/projects/clitrustsmoke') {
            json(200, { slug: 'clitrustsmoke' });
        } else if (request.url === '/api/v1/projects/Secure') {
            json(401, { message: 'Unauthenticated.' });
        } else if (request.url === '/api/v1/projects/Boom') {
            json(500, { message: 'boom' });
        } else if (request.url === '/api/v1/projects/Forbidden') {
            json(403, { message: 'Forbidden.' });
        } else {
            json(404, { message: 'Not found.' });
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

function config() {
    return { host: `http://127.0.0.1:${port}`, apiKey: 'k', workspaceId: 'w' };
}

describe('projectSlugCandidates', () => {
    it('production keeps the typed spelling, then the canonical slug', () => {
        expect(projectSlugCandidates('CliTrustSmoke', 'production')).toEqual(['CliTrustSmoke', 'clitrustsmoke']);
    });

    it('a non-production environment suffixes the typed spelling first', () => {
        expect(projectSlugCandidates('CliTrustSmoke', 'dev')).toEqual(['CliTrustSmoke-dev', 'clitrustsmoke-dev']);
    });

    it('an already-canonical name yields one candidate', () => {
        expect(projectSlugCandidates('my-app', 'production')).toEqual(['my-app']);
    });

    it('a name with nothing slugifiable yields only the typed spelling', () => {
        expect(projectSlugCandidates('!!!')).toEqual(['!!!']);
    });
});

describe('matchProjectRungs', () => {
    const rows = [
        { name: 'CliTrustSmoke', slug: 'clitrustsmoke', environment: 'production' },
        { name: 'Renamed', slug: 'my-proj', environment: 'production' },
    ];

    it('matches an exact name first', () => {
        expect(matchProjectRungs(rows, 'CliTrustSmoke')).toEqual({ project: rows[0], ambiguous: [] });
    });

    it('matches an exact slug second', () => {
        expect(matchProjectRungs(rows, 'clitrustsmoke')).toEqual({ project: rows[0], ambiguous: [] });
    });

    it('matches the canonical slug third', () => {
        expect(matchProjectRungs(rows, 'My Proj')).toEqual({ project: rows[1], ambiguous: [] });
    });

    it('matches a lone case-insensitive name last', () => {
        expect(matchProjectRungs([{ name: 'Main-App', slug: 'x' }], 'main-app')).toEqual({
            project: { name: 'Main-App', slug: 'x' },
            ambiguous: [],
        });
    });

    it('reports more than one case-insensitive hit as ambiguous', () => {
        const pair = [
            { name: 'Main-App', slug: 'a' },
            { name: 'MAIN-APP', slug: 'b' },
        ];
        expect(matchProjectRungs(pair, 'main-app')).toEqual({ project: null, ambiguous: pair });
    });

    it('misses everything on unknown rows', () => {
        expect(matchProjectRungs(rows, 'nope')).toEqual({ project: null, ambiguous: [] });
    });
});

describe('resolveProjectSlug', () => {
    it('a typed hit costs one request', async () => {
        seenPaths = [];
        const slug = await resolveProjectSlug(config(), 'typed-hit', 'production');
        expect(slug).toBe('typed-hit');
        expect(seenPaths).toEqual(['/api/v1/projects/typed-hit']);
    });

    it('a typed 404 falls through to the canonical slug and returns the server slug', async () => {
        seenPaths = [];
        const slug = await resolveProjectSlug(config(), 'CliTrustSmoke');
        expect(slug).toBe('clitrustsmoke');
        expect(seenPaths).toEqual(['/api/v1/projects/CliTrustSmoke', '/api/v1/projects/clitrustsmoke']);
    });

    it('all 404 returns the first candidate', async () => {
        seenPaths = [];
        const slug = await resolveProjectSlug(config(), 'Nope', 'production');
        expect(slug).toBe('Nope');
        expect(seenPaths).toEqual(['/api/v1/projects/Nope', '/api/v1/projects/nope']);
    });

    it('a 401 on the first lookup rejects without a second request', async () => {
        seenPaths = [];
        await expect(resolveProjectSlug(config(), 'Secure', 'production')).rejects.toMatchObject({
            response: { status: 401 },
        });
        expect(seenPaths).toEqual(['/api/v1/projects/Secure']);
    });

    it('a 500 rejects', async () => {
        seenPaths = [];
        await expect(resolveProjectSlug(config(), 'Boom', 'production')).rejects.toMatchObject({
            response: { status: 500 },
        });
        expect(seenPaths).toEqual(['/api/v1/projects/Boom']);
    });

    it('a 403 on the first lookup resolves to the first candidate (PM ruling 3)', async () => {
        seenPaths = [];
        const slug = await resolveProjectSlug(config(), 'Forbidden', 'production');
        expect(slug).toBe('Forbidden');
        expect(seenPaths).toEqual(['/api/v1/projects/Forbidden']);
    });
});
