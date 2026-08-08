import { describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
    schema: vi.fn(async () => undefined),
    query: vi.fn(async () => undefined),
    exec: vi.fn(async () => undefined),
}));

vi.mock('../src/commands/database', async (importOriginal) => ({
    ...await importOriginal<typeof import('../src/commands/database')>(),
    databaseSchema: handlers.schema,
    databaseQuery: handlers.query,
    databaseExec: handlers.exec,
}));

import { program } from '../src/index';

function databaseAction(verb: string): Function {
    const database = program.commands.find((command) => command.name() === 'database');
    const command = database?.commands.find((candidate) => candidate.name() === verb);
    expect(command, `database ${verb}`).toBeDefined();
    expect((command as any)?._actionHandler, `database ${verb} action`).toBeTypeOf('function');
    return (command as any)._actionHandler as Function;
}

describe('database direct command registration', () => {
    it('dispatches schema arguments and options to its command handler', async () => {
        const options = { json: true };

        await databaseAction('schema')('Analytics', options);

        expect(handlers.schema).toHaveBeenCalledOnce();
        expect(handlers.schema).toHaveBeenCalledWith('Analytics', options);
    });

    it('dispatches query arguments and options to its command handler', async () => {
        const options = { json: true };

        await databaseAction('query')('Analytics', 'SELECT 1', options);

        expect(handlers.query).toHaveBeenCalledOnce();
        expect(handlers.query).toHaveBeenCalledWith('Analytics', 'SELECT 1', options);
    });

    it('dispatches exec arguments and options to its command handler', async () => {
        const options = { yes: true, json: true };

        await databaseAction('exec')('Analytics', 'DELETE FROM events', options);

        expect(handlers.exec).toHaveBeenCalledOnce();
        expect(handlers.exec).toHaveBeenCalledWith('Analytics', 'DELETE FROM events', options);
    });
});
