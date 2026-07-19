/**
 * Stub SAA server for `scripts/smoke.sh`.
 *
 * A real HTTP server (repo convention — no mocking library), serving just the
 * `/api/v1/oauth-actions` surface the smoke script exercises. Reuses the same
 * JSON fixtures as the unit tests so the smoke run and the test suite can't
 * disagree about what the API returns.
 *
 * Prints the chosen port to stdout as `PORT=<n>` once listening.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(scriptDir, '..', 'tests', 'fixtures');

const loadFixture = (name) =>
    JSON.parse(readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8'));

const CALENDAR = loadFixture('calendar-events-list');

const GMAIL_ACTIONS = [
    {
        platform: 'gmail',
        method: 'POST',
        path: '/gmail/v1/users/me/messages/send',
        title: 'Send Message',
        action_id: 'conn_mod_def::GGSNOTZxFUU::ZWXBuJboTpS3Q_U06pF8gA',
        tags: ['mail', 'send'],
        io_schema: {
            ioExample: { input: { body: { connectionKey: 'placeholder-key', raw: 'x' } } },
        },
    },
    {
        platform: 'gmail',
        method: 'GET',
        path: '/gmail/v1/users/me/messages',
        title: 'List Messages',
        action_id: 'conn_get::LIST::MSGS',
        tags: ['mail', 'list'],
        io_schema: { ioExample: { input: { query: { q: 'is:unread', maxResults: '5' } } } },
    },
];

const BY_PLATFORM = {
    gmail: GMAIL_ACTIONS,
    'google-calendar': [CALENDAR],
};

const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
};

const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Every smoke request must carry the auth + workspace headers the CLI sends.
    if (!(req.headers.authorization || '').startsWith('Bearer ')) {
        return json(res, 401, { message: 'Missing bearer token' });
    }
    if (!req.headers['x-workspace-id']) {
        return json(res, 400, { message: 'Missing X-Workspace-Id header' });
    }

    const segments = url.pathname.split('/').filter(Boolean);
    // ['api','v1','oauth-actions', <platform>?, <action_id>?]
    if (segments[0] !== 'api' || segments[1] !== 'v1' || segments[2] !== 'oauth-actions') {
        return json(res, 404, { message: 'Not found' });
    }

    // GET /api/v1/oauth-actions?platform=&q=&limit=   (list + search)
    if (segments.length === 3) {
        const platform = url.searchParams.get('platform');
        const actions = BY_PLATFORM[platform];
        if (!actions) {
            return json(res, 404, { code: 'platform_unknown', message: `Unknown platform ${platform}` });
        }

        let results = actions;
        const q = url.searchParams.get('q');
        if (q) {
            const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
            results = results.filter((a) => {
                const haystack = `${a.title} ${a.path} ${(a.tags || []).join(' ')}`.toLowerCase();
                return terms.some((t) => haystack.includes(t));
            });
        }
        const limit = Number(url.searchParams.get('limit'));
        if (Number.isFinite(limit) && limit > 0) results = results.slice(0, limit);

        return json(res, 200, { oauth_actions: results });
    }

    // GET /api/v1/oauth-actions/<platform>/<action_id>   (show)
    if (segments.length === 5) {
        const [, , , platform, rawActionId] = segments;
        const actionId = decodeURIComponent(rawActionId);
        const hit = (BY_PLATFORM[platform] || []).find((a) => a.action_id === actionId);
        if (!hit) return json(res, 404, { message: `Action not found: ${platform}/${actionId}` });
        return json(res, 200, { oauth_action: hit });
    }

    return json(res, 404, { message: 'Not found' });
});

server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`PORT=${server.address().port}\n`);
});
