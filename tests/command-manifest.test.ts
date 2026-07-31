// #1004 PR 0: the walker turns the commander tree into the machine-readable
// manifest the content repo pins. Real Command objects, no mocks.
import { describe, expect, it } from 'vitest';
import { Command, Option } from 'commander';
import path from 'path';
import fs from 'fs';
import { buildCommandManifest, COMMAND_MANIFEST_SCHEMA_VERSION } from '../src/utils/command-manifest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');
const pkg = require('../package.json');

function findCommand(manifest: ReturnType<typeof buildCommandManifest>, ...segments: string[]) {
    return manifest.commands.find((c) => c.path.join(' ') === segments.join(' '));
}

describe('buildCommandManifest — synthetic trees', () => {
    it('records nouns, verbs, and nesting depth as path arrays', () => {
        const program = new Command().name('demo');
        const crew = program.command('crew').description('Manage crews');
        const crewEnv = crew.command('env').description('Manage crew variables');
        crewEnv.command('set').description('Set a variable');

        const manifest = buildCommandManifest(program, '9.9.9');

        expect(manifest.schema_version).toBe(COMMAND_MANIFEST_SCHEMA_VERSION);
        expect(manifest.cli_name).toBe('demo');
        expect(manifest.cli_version).toBe('9.9.9');
        expect(findCommand(manifest, 'crew', 'env', 'set')).toBeDefined();
        expect(findCommand(manifest, 'crew', 'env', 'set')!.description).toBe('Set a variable');
    });

    it('captures both long and short option forms', () => {
        const program = new Command().name('demo');
        program.command('go').option('-e, --env <environment>', 'Environment');

        const opt = findCommand(buildCommandManifest(program, '0.0.0'), 'go')!.options[0];

        expect(opt.long).toBe('--env');
        expect(opt.short).toBe('-e');
        expect(opt.flags).toBe('-e, --env <environment>');
        expect(opt.value_required).toBe(true);
    });

    it('marks hideHelp options hidden and leaves visible options visible', () => {
        const program = new Command().name('demo');
        program
            .command('login')
            .addOption(new Option('--host <url>', 'Custom API host URL').hideHelp())
            .option('--device', 'Device login');

        const options = findCommand(buildCommandManifest(program, '0.0.0'), 'login')!.options;

        expect(options.find((o) => o.long === '--host')!.hidden).toBe(true);
        expect(options.find((o) => o.long === '--device')!.hidden).toBe(false);
    });

    it('marks commands declared with { hidden: true } as hidden', () => {
        const program = new Command().name('demo');
        const skill = program.command('skill');
        skill.command('run', { hidden: true }).description('Deprecated alias');
        skill.command('dev').description('Run a skill');

        const manifest = buildCommandManifest(program, '0.0.0');

        expect(findCommand(manifest, 'skill', 'run')!.hidden).toBe(true);
        expect(findCommand(manifest, 'skill', 'dev')!.hidden).toBe(false);
    });

    it('marks requiredOption as required and plain options as not', () => {
        const program = new Command().name('demo');
        program.command('exec').requiredOption('--target <target>', 'Where to execute').option('--dry-run', 'Preview');

        const options = findCommand(buildCommandManifest(program, '0.0.0'), 'exec')!.options;

        expect(options.find((o) => o.long === '--target')!.required).toBe(true);
        expect(options.find((o) => o.long === '--dry-run')!.required).toBe(false);
    });

    it('records negated boolean options under their --no- spelling', () => {
        const program = new Command().name('demo');
        program.command('deploy').option('--no-cache', 'Force a fresh build');

        const opt = findCommand(buildCommandManifest(program, '0.0.0'), 'deploy')!.options[0];

        expect(opt.long).toBe('--no-cache');
        expect(opt.negated).toBe(true);
    });

    it('records JSON-safe defaults and omits unserializable ones', () => {
        const program = new Command().name('demo');
        program
            .command('list')
            .option('-e, --env <environment>', 'Environment', 'dev')
            .option('--parsed <n>', 'Parsed number', parseInt)
            .addOption(new Option('--computed <v>', 'Computed').default(() => 1, 'a computed value'));

        const options = findCommand(buildCommandManifest(program, '0.0.0'), 'list')!.options;

        expect(options.find((o) => o.long === '--env')!.default).toBe('dev');
        expect(options.find((o) => o.long === '--parsed')).toMatchObject({ long: '--parsed' });
        expect(options.find((o) => o.long === '--parsed')!.default).toBeUndefined();
        expect(options.find((o) => o.long === '--computed')!.default).toBeUndefined();
        expect(options.find((o) => o.long === '--computed')!.default_description).toBe('a computed value');
    });

    it('captures positional arguments from both declaration idioms', () => {
        const program = new Command().name('demo');
        program.command('deploy').argument('<project-name>', 'Project name').argument('[path]', 'Source directory');
        program.command('search <platform> [query]').description('Search');
        program.command('upload <files...>').description('Upload');

        const manifest = buildCommandManifest(program, '0.0.0');

        expect(findCommand(manifest, 'deploy')!.arguments).toMatchObject([
            { name: 'project-name', required: true, variadic: false },
            { name: 'path', required: false, variadic: false },
        ]);
        expect(findCommand(manifest, 'search')!.arguments).toMatchObject([
            { name: 'platform', required: true },
            { name: 'query', required: false },
        ]);
        expect(findCommand(manifest, 'upload')!.arguments).toMatchObject([{ name: 'files', variadic: true }]);
    });

    it('separates program-level global options from command options', () => {
        const program = new Command().name('demo');
        program.option('-w, --workspace-override <id>', 'Override workspace');
        program.command('go').option('--flag', 'A flag');

        const manifest = buildCommandManifest(program, '0.0.0');

        expect(manifest.global_options.map((o) => o.long)).toEqual(['--workspace-override']);
        expect(manifest.commands.map((c) => c.path.join(' '))).toEqual(['go']);
    });

    it('produces output that survives a JSON round-trip unchanged', () => {
        const program = new Command().name('demo');
        program.command('go').option('-e, --env <e>', 'Env', 'dev').argument('<name>', 'Name');

        const manifest = buildCommandManifest(program, '0.0.0');

        expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    });
});

describe('buildCommandManifest — the real solidactions program', () => {
    it('captures the real hidden flags, hidden command, and required option', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true); // CLI not built — run `npm run build` first
        const { program } = require(CLI_BINARY);

        const manifest = buildCommandManifest(program, pkg.version);

        const login = findCommand(manifest, 'login')!;
        expect(login.options.find((o) => o.long === '--host')!.hidden).toBe(true);
        expect(login.options.find((o) => o.long === '--dev')!.hidden).toBe(true);
        expect(login.options.find((o) => o.long === '--device')!.hidden).toBe(false);

        expect(findCommand(manifest, 'skill', 'run')!.hidden).toBe(true);
        expect(findCommand(manifest, 'skill', 'exec')!.options.find((o) => o.long === '--target')!.required).toBe(true);

        const deploy = findCommand(manifest, 'project', 'deploy')!;
        expect(deploy.options.find((o) => o.long === '--env')!.short).toBe('-e');
        expect(deploy.options.find((o) => o.long === '--create')).toBeDefined();
        expect(deploy.options.find((o) => o.long === '--no-cache')!.negated).toBe(true);
        expect(deploy.arguments.map((a) => a.name)).toEqual(['project-name', 'path']);

        expect(findCommand(manifest, 'crew', 'env', 'set')).toBeDefined();
        expect(manifest.global_options.map((o) => o.long)).toContain('--workspace-override');
        expect(manifest.cli_name).toBe('solidactions');
    });
});
