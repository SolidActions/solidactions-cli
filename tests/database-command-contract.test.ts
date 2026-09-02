import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildCommandManifest } from '../src/utils/command-manifest';

const DIST = path.resolve(__dirname, '../dist');
const CLI_BINARY = path.join(DIST, 'index.js');
const MANIFEST_PATH = path.join(DIST, 'command-manifest.json');
const pkg = require('../package.json');

const COMMANDS = [
    { verb: 'list', args: [], options: ['--json'] },
    { verb: 'create', args: [['name', true]], options: ['--from', '--json'] },
    { verb: 'show', args: [['name', true]], options: ['--json'] },
    { verb: 'delete', args: [['name', true]], options: ['--yes', '--json'] },
    { verb: 'undelete', args: [['name', true]], options: ['--json'] },
    { verb: 'schema', args: [['name', true]], options: ['--json'] },
    { verb: 'query', args: [['name', true], ['sql', true]], options: ['--json'] },
    { verb: 'exec', args: [['name', true], ['sql', true]], options: ['--yes', '--json'] },
    { verb: 'dump', args: [['name', true], ['file', false]], options: ['--yes'] },
    { verb: 'pull', args: [['name', true], ['path', false]], options: ['--yes', '--writable'] },
    { verb: 'import', args: [['name', true], ['file.sql', true]], options: ['--yes', '--resume'] },
    { verb: 'push', args: [['database', true], ['file.db', true]], options: ['--yes'] },
] as const;

const CRITICAL_OPTIONS = ['--json', '--from', '--yes', '--writable', '--resume'];

function loadProgram(): any {
    expect(fs.existsSync(CLI_BINARY)).toBe(true); // CLI not built — run `npm run build` first
    return require(CLI_BINARY).program;
}

describe('database command tree', () => {
    it('exports the singular noun with the complete public verbs', () => {
        const program = loadProgram();
        const nouns = program.commands.map((command: any) => command.name());
        const database = program.commands.find((command: any) => command.name() === 'database');

        expect(nouns).toContain('database');
        expect(nouns).not.toContain('databases');
        expect(database).toBeDefined();
        expect(database.commands.map((command: any) => command.name())).toEqual(
            COMMANDS.map(({ verb }) => verb),
        );
    });

    it('declares the required/optional arguments and critical option matrix', () => {
        const program = loadProgram();
        const database = program.commands.find((command: any) => command.name() === 'database');

        expect(database).toBeDefined();
        if (!database) return;

        for (const expected of COMMANDS) {
            const command = database.commands.find((candidate: any) => candidate.name() === expected.verb);
            expect(command, `database ${expected.verb}`).toBeDefined();
            if (!command) continue;

            expect(command.registeredArguments.map((argument: any) => [argument.name(), argument.required])).toEqual(
                expected.args,
            );

            const declaredCriticalOptions = command.options
                .map((option: any) => option.long)
                .filter((option: string) => CRITICAL_OPTIONS.includes(option));
            expect(declaredCriticalOptions).toEqual(expected.options);

            const expectedOptions: readonly string[] = expected.options;
            const yes = command.options.find((option: any) => option.long === '--yes');
            if (expectedOptions.includes('--yes')) expect(yes?.short).toBe('-y');

            const from = command.options.find((option: any) => option.long === '--from');
            if (expectedOptions.includes('--from')) expect(from?.required).toBe(true);

            const resume = command.options.find((option: any) => option.long === '--resume');
            if (expectedOptions.includes('--resume')) expect(resume?.required).toBe(true);
        }
    });

    it('explains push normalization and countable-row exclusions in help', () => {
        const program = loadProgram();
        const push = program.commands.find((command: any) => command.name() === 'database')
            ?.commands.find((command: any) => command.name() === 'push');
        const help = push.helpInformation();
        expect(help).toMatch(/WAL.*4096.*auto-vacuum NONE/is);
        expect(help).toMatch(/source file is\s+unchanged/i);
        expect(help).toMatch(/countable rows.*internal.*virtual.*shadow/is);
    });
});

describe('database command manifest', () => {
    it('walks the complete database contract from the exported tree', () => {
        const manifest = buildCommandManifest(loadProgram(), pkg.version);
        const databaseCommands = manifest.commands.filter(
            (command) => command.path[0] === 'database' && command.path.length === 2 && command.name !== 'help',
        );

        expect(manifest.commands.some((command) => command.path.join(' ') === 'database')).toBe(true);
        expect(manifest.commands.some((command) => command.path[0] === 'databases')).toBe(false);
        expect(databaseCommands.map((command) => command.name)).toEqual(COMMANDS.map(({ verb }) => verb));

        for (const expected of COMMANDS) {
            const command = databaseCommands.find((candidate) => candidate.name === expected.verb)!;
            expect(command.arguments.map((argument) => [argument.name, argument.required])).toEqual(expected.args);
            expect(
                command.options
                    .map((option) => option.long)
                    .filter((option): option is string => option !== null && CRITICAL_OPTIONS.includes(option)),
            ).toEqual(expected.options);
        }
    });

    it('emits the same complete database contract in the build artifact', () => {
        expect(fs.existsSync(MANIFEST_PATH)).toBe(true); // CLI not built — run `npm run build` first
        const onDisk = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        const fresh = JSON.parse(JSON.stringify(buildCommandManifest(loadProgram(), pkg.version)));

        expect(onDisk).toEqual(fresh);
        expect(
            onDisk.commands
                .filter((command: any) => command.path[0] === 'database' && command.path.length === 2 && command.name !== 'help')
                .map((command: any) => command.name),
        ).toEqual(COMMANDS.map(({ verb }) => verb));
    });
});
