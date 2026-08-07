import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

interface ProbeOptions {
    createClient: (config: Record<string, unknown>) => unknown;
    remoteUrl: string;
    localUrl: string;
}

async function loadProbe(): Promise<(options: ProbeOptions) => Promise<void>> {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../scripts/probe-database-client-sync.mjs')).href;
    const module = await import(moduleUrl) as Record<string, unknown>;

    expect(module.runRemoteSyncProbe).toBeTypeOf('function');
    return module.runRemoteSyncProbe as (options: ProbeOptions) => Promise<void>;
}

function statementSql(statement: unknown): string {
    if (typeof statement === 'string') return statement;
    return String((statement as { sql?: unknown })?.sql ?? '');
}

describe('remote database sync probe', () => {
    it('seeds the remote before opening, syncing, and querying a local file replica', async () => {
        const runRemoteSyncProbe = await loadProbe();
        const remoteUrl = 'http://127.0.0.1:8080';
        const localUrl = 'file:/tmp/solidactions-sync-probe.db';
        const events: string[] = [];
        const remoteStatements: string[] = [];
        const localStatements: string[] = [];
        const clientConfigs: Array<Record<string, unknown>> = [];

        await runRemoteSyncProbe({
            remoteUrl,
            localUrl,
            createClient: (config) => {
                clientConfigs.push(config);
                if (config.url === remoteUrl) {
                    events.push('open-remote');
                    return {
                        execute: async (statement: unknown) => {
                            remoteStatements.push(statementSql(statement));
                            events.push('seed-remote');
                            return { rows: [] };
                        },
                        close: () => events.push('close-remote'),
                    };
                }

                events.push('open-local');
                return {
                    sync: async () => events.push('sync-local'),
                    execute: async (statement: unknown) => {
                        localStatements.push(statementSql(statement));
                        events.push('query-local');
                        return { rows: [{ value: 'remote-sync-ready' }] };
                    },
                    close: () => events.push('close-local'),
                };
            },
        });

        expect(clientConfigs).toEqual([
            expect.objectContaining({ url: remoteUrl }),
            expect.objectContaining({ url: localUrl, syncUrl: remoteUrl }),
        ]);
        expect(remoteStatements).toHaveLength(2);
        expect(remoteStatements[0]).toMatch(/^CREATE TABLE/i);
        expect(remoteStatements[1]).toMatch(/^INSERT INTO/i);
        expect(localStatements).toHaveLength(1);
        expect(localStatements[0]).toMatch(/^SELECT /i);
        expect(events.indexOf('seed-remote')).toBeLessThan(events.indexOf('open-local'));
        expect(events.indexOf('sync-local')).toBeLessThan(events.indexOf('query-local'));
        expect(events).toContain('close-remote');
        expect(events).toContain('close-local');
    });

    it('rejects an unexpected synced row and still closes both clients', async () => {
        const runRemoteSyncProbe = await loadProbe();
        const closed: string[] = [];

        await expect(runRemoteSyncProbe({
            remoteUrl: 'http://127.0.0.1:8080',
            localUrl: 'file:/tmp/solidactions-sync-probe.db',
            createClient: (config) => config.syncUrl
                ? {
                    sync: async () => undefined,
                    execute: async () => ({ rows: [{ value: 'wrong-row' }] }),
                    close: () => closed.push('local'),
                }
                : {
                    execute: async () => ({ rows: [] }),
                    close: () => closed.push('remote'),
                },
        })).rejects.toThrow(/unexpected result/i);

        expect(closed).toEqual(expect.arrayContaining(['remote', 'local']));
    });
});
