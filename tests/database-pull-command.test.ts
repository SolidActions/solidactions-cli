import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Config {
    host: string;
    apiKey: string;
    workspaceId: string;
}

const CONFIG: Config = {
    host: 'https://app.example.test',
    apiKey: 'control-plane-pat-sentinel',
    workspaceId: 'workspace-1146',
};

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        fs.chmodSync(root, 0o700);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

async function requirePull(): Promise<Function> {
    const url = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;
    let module: Record<string, unknown> = {};
    try {
        module = await import(url) as Record<string, unknown>;
    } catch {
        // The first TDD slice intentionally lands before the production export.
    }
    expect(module.databasePullWithConfig, 'databasePullWithConfig export').toBeTypeOf('function');
    return module.databasePullWithConfig as Function;
}

function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-database-pull-'));
    roots.push(root);
    return root;
}

function pullHarness(
    root: string,
    sync: (attempt: number, config: Record<string, unknown>) => Promise<void> = async (_attempt, config) => {
        fs.writeFileSync(fileURLToPath(String(config.url)), 'READ ONLY REPLICA');
    },
) {
    const events: string[] = [];
    const posts: Array<{ url: string; body: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const clientConfigs: Array<Record<string, unknown>> = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const confirm = vi.fn(async () => true as boolean | undefined);
    let attempt = 0;

    const dependencies = {
        cwd: root,
        tempPath: (target: string) => path.join(path.dirname(target), `.${path.basename(target)}.solidactions-task7.tmp`),
        loadClient: async () => {
            events.push('load');
            return {
                createClient: (config: Record<string, unknown>) => {
                    const current = ++attempt;
                    clientConfigs.push(config);
                    events.push(`create:${current}`);
                    return {
                        sync: async () => {
                            events.push(`sync:${current}`);
                            await sync(current, config);
                        },
                        close: async () => {
                            events.push(`close:${current}`);
                        },
                    };
                },
            };
        },
        post: async (url: string, body: Record<string, unknown>, options: Record<string, unknown>) => {
            const mint = posts.length + 1;
            events.push(`mint:${mint}`);
            posts.push({ url, body, options });
            return {
                data: {
                    url: 'libsql://physical-hostname.sentinel.invalid',
                    token: `fresh-read-token-sentinel-${mint}`,
                    mode: 'read',
                    expires_at: '2026-08-07T12:10:00Z',
                },
            };
        },
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
        confirm,
        isTTY: true,
    };

    return { events, posts, clientConfigs, stdout, stderr, confirm, dependencies };
}

function expectOnlyReadAccess(posts: ReturnType<typeof pullHarness>['posts'], name = 'Analytics'): void {
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
        expect(post).toEqual({
            url: 'https://app.example.test/api/v1/databases',
            body: { operation: 'access', name, mode: 'read' },
            options: {
                headers: {
                    Accept: 'application/json',
                    Authorization: 'Bearer control-plane-pat-sentinel',
                    'Content-Type': 'application/json',
                    'X-Workspace-Id': 'workspace-1146',
                },
            },
        });
    }
    expect(JSON.stringify(posts)).not.toContain('READ ONLY REPLICA');
    expect(JSON.stringify(posts)).not.toContain('SELECT');
}

describe('database pull read-only replica contract', () => {
    it.each([
        { name: '../../', expected: path.join('.solidactions', 'databases', 'database.db') },
        { name: '../../Customer Data/2026', expected: path.join('.solidactions', 'databases', 'customer-data-2026.db') },
        { name: '/tmp/Root DB', expected: path.join('.solidactions', 'databases', 'tmp-root-db.db') },
    ])('keeps the safe default for $name under $expected', async ({ name, expected }) => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const test = pullHarness(root);

        await databasePullWithConfig(name, undefined, {}, CONFIG, test.dependencies);

        const target = path.join(root, expected);
        expect(fs.readFileSync(target, 'utf8')).toBe('READ ONLY REPLICA');
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expect(path.relative(path.join(root, '.solidactions', 'databases'), target)).not.toMatch(/^\.\.(?:[/\\]|$)/);
        expectOnlyReadAccess(test.posts, name);
        expect(test.stdout.join('\n')).toContain(expected);
        expect(test.stderr).toEqual([]);
    });

    it('creates explicit parents and loads native support before minting read access', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'nested', 'replicas', 'analytics.db');
        const realPromises = fs.promises;
        const events: string[] = [];
        const test = pullHarness(root);
        test.dependencies.filesystem = {
            ...realPromises,
            chmod: async (file: fs.PathLike, mode: fs.Mode) => {
                events.push('chmod');
                return realPromises.chmod(file, mode);
            },
            rename: async (from: fs.PathLike, to: fs.PathLike) => {
                events.push('rename');
                return realPromises.rename(from, to);
            },
        } as any;
        const originalLoad = test.dependencies.loadClient;
        test.dependencies.loadClient = async () => {
            events.push('load');
            const loaded = await originalLoad();
            return {
                createClient: (config: Record<string, unknown>) => {
                    const client = loaded.createClient(config);
                    const close = client.close;
                    client.close = async () => {
                        events.push('close');
                        await close();
                    };
                    return client;
                },
            };
        };
        const originalPost = test.dependencies.post;
        test.dependencies.post = async (...args: any[]) => {
            events.push('mint');
            return (originalPost as any)(...args);
        };

        await databasePullWithConfig('Analytics', target, {}, CONFIG, test.dependencies);

        expect(events.indexOf('load')).toBeLessThan(events.indexOf('mint'));
        expect(events.indexOf('close')).toBeLessThan(events.indexOf('chmod'));
        expect(events.indexOf('chmod')).toBeLessThan(events.indexOf('rename'));
        expect(fs.readFileSync(target, 'utf8')).toBe('READ ONLY REPLICA');
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expect(test.clientConfigs).toHaveLength(1);
        const tempUrl = String(test.clientConfigs[0].url);
        expect(tempUrl).toBe(pathToFileURL(path.join(path.dirname(target), '.analytics.db.solidactions-task7.tmp')).href);
        expect(test.clientConfigs[0]).toEqual({
            url: tempUrl,
            syncUrl: 'libsql://physical-hostname.sentinel.invalid',
            authToken: 'fresh-read-token-sentinel-1',
            intMode: 'string',
        });
        expectOnlyReadAccess(test.posts);
    });

    it.each([
        { label: 'non-TTY', isTTY: false, answer: true },
        { label: 'decline', isTTY: true, answer: false },
        { label: 'EOF', isTTY: true, answer: undefined },
    ])('$label refuses an existing target before native load, mint, or file changes', async ({ isTTY, answer }) => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'existing.db');
        fs.writeFileSync(target, 'OLD REPLICA');
        const test = pullHarness(root);
        test.dependencies.isTTY = isTTY;
        test.dependencies.confirm = vi.fn(async () => answer);

        const outcome = databasePullWithConfig('Analytics', target, {}, CONFIG, test.dependencies);
        if (isTTY) await outcome;
        else await expect(outcome).rejects.toMatchObject({ code: 'confirmation_required' });

        expect(test.posts).toEqual([]);
        expect(test.clientConfigs).toEqual([]);
        expect(test.events).toEqual([]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
    });

    it('refuses a destination symlink before native load or mint, even with --yes', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const outside = path.join(root, 'outside.db');
        const target = path.join(root, 'linked.db');
        fs.writeFileSync(outside, 'DO NOT REPLACE');
        fs.symlinkSync(outside, target);
        const test = pullHarness(root);

        await expect(databasePullWithConfig('Analytics', target, { yes: true }, CONFIG, test.dependencies))
            .rejects.toThrow(/symbolic link/i);

        expect(test.events).toEqual([]);
        expect(test.posts).toEqual([]);
        expect(test.confirm).not.toHaveBeenCalled();
        expect(fs.readFileSync(outside, 'utf8')).toBe('DO NOT REPLACE');
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    });

    it('refuses a symlinked destination parent before native load, mint, or file creation', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const outside = path.join(root, 'outside');
        const linkedParent = path.join(root, 'replicas');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'analytics.db'), 'OUTSIDE REPLICA');
        fs.symlinkSync(outside, linkedParent, 'dir');
        const test = pullHarness(root);

        await expect(databasePullWithConfig(
            'Analytics',
            path.join(linkedParent, 'analytics.db'),
            { yes: true },
            CONFIG,
            test.dependencies,
        )).rejects.toThrow(/symbolic link/i);

        expect(test.events).toEqual([]);
        expect(test.posts).toEqual([]);
        expect(test.confirm).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(outside, 'analytics.db'), 'utf8')).toBe('OUTSIDE REPLICA');
        expect(fs.readdirSync(outside)).toEqual(['analytics.db']);
    });

    it('reserves its sibling temp exclusively and never removes a colliding pre-existing file', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        const temp = path.join(root, '.analytics.db.solidactions-task7.tmp');
        fs.writeFileSync(temp, 'PRE-EXISTING TEMP OWNED BY SOMEONE ELSE');
        const test = pullHarness(root);

        await expect(databasePullWithConfig('Analytics', target, {}, CONFIG, test.dependencies))
            .rejects.toThrow(/temporary|already exists|failed/i);

        expect(test.posts).toEqual([]);
        expect(test.clientConfigs).toEqual([]);
        expect(fs.existsSync(target)).toBe(false);
        expect(fs.readFileSync(temp, 'utf8')).toBe('PRE-EXISTING TEMP OWNED BY SOMEONE ELSE');
    });

    it('makes exactly three attempts with fresh read access, the same temp path, and a close per failed sync', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'existing.db');
        const unrelated = path.join(root, '.someone-elses-replica.tmp');
        fs.writeFileSync(target, 'OLD REPLICA');
        fs.writeFileSync(unrelated, 'DO NOT DELETE');
        const test = pullHarness(root, async (_attempt, config) => {
            const temp = fileURLToPath(String(config.url));
            fs.writeFileSync(temp, 'PARTIAL REPLICA');
            fs.writeFileSync(`${temp}-wal`, 'WAL');
            fs.writeFileSync(`${temp}-shm`, 'SHM');
            throw new Error(`sync failure physical-hostname.sentinel.invalid ${String(config.authToken)}`);
        });

        let caught: any;
        try {
            await databasePullWithConfig('Analytics', target, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(test.posts).toHaveLength(3);
        expectOnlyReadAccess(test.posts);
        expect(test.clientConfigs).toHaveLength(3);
        expect(new Set(test.clientConfigs.map((config) => config.url))).toHaveLength(1);
        expect(test.clientConfigs.map((config) => config.authToken)).toEqual([
            'fresh-read-token-sentinel-1',
            'fresh-read-token-sentinel-2',
            'fresh-read-token-sentinel-3',
        ]);
        expect(test.events.filter((event) => event.startsWith('close:'))).toEqual(['close:1', 'close:2', 'close:3']);
        expect(caught).toMatchObject({ code: 'upstream_unavailable' });
        const publicError = `${caught?.message ?? ''} ${caught?.stack ?? ''} ${JSON.stringify(caught)}`;
        expect(publicError).toMatch(/failed/i);
        expect(publicError).not.toContain('physical-hostname.sentinel.invalid');
        expect(publicError).not.toContain('fresh-read-token-sentinel');
        expect(publicError).not.toContain(CONFIG.apiKey);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        const temp = fileURLToPath(String(test.clientConfigs[0].url));
        expect(fs.existsSync(temp)).toBe(false);
        expect(fs.existsSync(`${temp}-wal`)).toBe(false);
        expect(fs.existsSync(`${temp}-shm`)).toBe(false);
        expect(fs.readFileSync(unrelated, 'utf8')).toBe('DO NOT DELETE');
    });

    it('stops renewing after the first successful resumed sync', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        const test = pullHarness(root, async (attempt, config) => {
            const temp = fileURLToPath(String(config.url));
            fs.writeFileSync(temp, attempt === 1 ? 'PARTIAL' : 'COMPLETE REPLICA');
            if (attempt === 1) throw new Error('expired credential with raw details');
        });

        await databasePullWithConfig('Analytics', target, {}, CONFIG, test.dependencies);

        expect(test.posts).toHaveLength(2);
        expect(test.clientConfigs).toHaveLength(2);
        expect(test.clientConfigs[0].url).toBe(test.clientConfigs[1].url);
        expect(test.events.filter((event) => event.startsWith('close:'))).toEqual(['close:1', 'close:2']);
        expect(fs.readFileSync(target, 'utf8')).toBe('COMPLETE REPLICA');
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
    });

    it('hands the exclusive reservation to native creation once, then preserves the partial replica for retry', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        const temp = path.join(root, '.analytics.db.solidactions-task7.tmp');
        const test = pullHarness(root);
        let loads = 0;
        let creates = 0;

        test.dependencies.loadClient = async () => {
            loads += 1;
            expect(fs.existsSync(temp), 'exclusive reservation or partial replica must exist while loading native support')
                .toBe(true);
            if (loads > 1) {
                expect(fs.readFileSync(temp, 'utf8')).toBe('PARTIAL REPLICA');
            }

            return {
                createClient: (config: Record<string, unknown>) => {
                    creates += 1;
                    expect(fileURLToPath(String(config.url))).toBe(temp);
                    if (creates === 1) {
                        expect(fs.existsSync(temp), 'native client must create the initial replica itself').toBe(false);
                        fs.writeFileSync(temp, 'NATIVE REPLICA');
                    } else {
                        expect(fs.readFileSync(temp, 'utf8'), 'retry must retain incremental replica state')
                            .toBe('PARTIAL REPLICA');
                    }

                    return {
                        sync: async () => {
                            if (creates === 1) {
                                fs.writeFileSync(temp, 'PARTIAL REPLICA');
                                throw new Error('first sync needs fresh read access');
                            }
                            fs.writeFileSync(temp, 'COMPLETE REPLICA');
                        },
                        close: async () => undefined,
                    };
                },
            };
        };

        await databasePullWithConfig('Analytics', target, {}, CONFIG, test.dependencies);

        expect(loads).toBe(2);
        expect(creates).toBe(2);
        expect(test.posts).toHaveLength(2);
        expectOnlyReadAccess(test.posts);
        expect(fs.readFileSync(target, 'utf8')).toBe('COMPLETE REPLICA');
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
    });

    it('rolls back only its own replica when final rename fails and scrubs filesystem details', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'existing.db');
        const ownTemp = path.join(root, '.existing.db.solidactions-task7.tmp');
        const unrelated = path.join(root, '.unrelated.solidactions-other.tmp');
        fs.writeFileSync(target, 'OLD REPLICA');
        fs.writeFileSync(unrelated, 'NOT OUR FILE');
        const test = pullHarness(root);
        test.dependencies.filesystem = {
            ...fs.promises,
            rename: async () => {
                throw new Error(`rename leaked ${CONFIG.apiKey} RAW_RENAME_PATH_SENTINEL`);
            },
        } as any;

        let caught: any;
        try {
            await databasePullWithConfig('Analytics', target, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'upstream_unavailable' });
        const publicError = `${caught?.message ?? ''} ${caught?.stack ?? ''} ${JSON.stringify(caught)}`;
        expect(publicError).not.toContain(CONFIG.apiKey);
        expect(publicError).not.toContain('RAW_RENAME_PATH_SENTINEL');
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.existsSync(ownTemp)).toBe(false);
        expect(fs.readFileSync(unrelated, 'utf8')).toBe('NOT OUR FILE');
    });

    it('cleans a reserved temp after native loading fails before minting while preserving other files', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'existing.db');
        const ownTemp = path.join(root, '.existing.db.solidactions-task7.tmp');
        const unrelated = path.join(root, '.unrelated.solidactions-other.tmp');
        fs.writeFileSync(target, 'OLD REPLICA');
        fs.writeFileSync(unrelated, 'NOT OUR FILE');
        const test = pullHarness(root);
        test.dependencies.loadClient = async () => {
            expect(fs.existsSync(ownTemp), 'temp must be reserved before native loading').toBe(true);
            throw new Error('NATIVE_LOAD_SECRET_SENTINEL');
        };

        let caught: any;
        try {
            await databasePullWithConfig('Analytics', target, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'database_client_unsupported' });
        expect(`${caught?.message ?? ''} ${caught?.stack ?? ''} ${JSON.stringify(caught)}`)
            .not.toContain('NATIVE_LOAD_SECRET_SENTINEL');
        expect(test.posts).toEqual([]);
        expect(test.clientConfigs).toEqual([]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.existsSync(ownTemp)).toBe(false);
        expect(fs.readFileSync(unrelated, 'utf8')).toBe('NOT OUR FILE');
    });

    it('fails --writable closed before filesystem work, native load, or mint', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'missing', 'analytics.db');
        const test = pullHarness(root);

        await expect(databasePullWithConfig('Analytics', target, { writable: true }, CONFIG, test.dependencies))
            .rejects.toThrow(/writable.*not available|not available.*writable/i);

        expect(test.events).toEqual([]);
        expect(test.posts).toEqual([]);
        expect(test.clientConfigs).toEqual([]);
        expect(fs.existsSync(path.dirname(target))).toBe(false);
    });
});
