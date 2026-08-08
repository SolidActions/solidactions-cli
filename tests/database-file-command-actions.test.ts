import { describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
    dump: vi.fn(async () => undefined),
    pull: vi.fn(async () => undefined),
}));

vi.mock('../src/commands/database', async (importOriginal) => ({
    ...await importOriginal<typeof import('../src/commands/database')>(),
    databaseDump: handlers.dump,
    databasePull: handlers.pull,
}));

import { program } from '../src/index';

function databaseCommand(verb: string): any {
    const database = program.commands.find((command) => command.name() === 'database');
    const command = database?.commands.find((candidate) => candidate.name() === verb);
    expect(command, `database ${verb}`).toBeDefined();
    expect((command as any)?._actionHandler, `database ${verb} action`).toBeTypeOf('function');
    return command;
}

describe('database file command registration', () => {
    it('dispatches dump name, optional destination, and overwrite option', async () => {
        await databaseCommand('dump').parseAsync(
            ['../../Customer Data', './backups/customer.sql', '--yes'],
            { from: 'user' },
        );

        expect(handlers.dump).toHaveBeenCalledOnce();
        expect(handlers.dump).toHaveBeenCalledWith(
            '../../Customer Data',
            './backups/customer.sql',
            { yes: true },
        );
    });

    it('dispatches pull name, optional destination, and pull options', async () => {
        await databaseCommand('pull').parseAsync(
            ['Analytics', './replicas/analytics.db', '--yes', '--writable'],
            { from: 'user' },
        );

        expect(handlers.pull).toHaveBeenCalledOnce();
        expect(handlers.pull).toHaveBeenCalledWith(
            'Analytics',
            './replicas/analytics.db',
            { yes: true, writable: true },
        );
    });
});
