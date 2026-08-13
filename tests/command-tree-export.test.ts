// #1004 PR 0: the command tree must be importable so the manifest generator can
// walk it. Requiring the module must NOT parse argv or exit the process.
import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

describe('command tree export', () => {
    it('requires the built CLI without parsing argv or exiting', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true); // CLI not built — run `npm run build` first
        const mod = require(CLI_BINARY);
        expect(mod.program).toBeDefined();
    });

    it('exposes the assembled noun-verb tree', () => {
        const { program } = require(CLI_BINARY);
        const nouns = program.commands.map((c: any) => c.name());
        expect(nouns).toContain('project');
        expect(nouns).toContain('login');
        expect(nouns).toContain('skill');

        const project = program.commands.find((c: any) => c.name() === 'project');
        const verbs = project.commands.map((c: any) => c.name());
        expect(verbs).toContain('deploy');
        expect(verbs).toContain('view');

        const schedule = program.commands.find((c: any) => c.name() === 'schedule');
        const scheduleVerbs = schedule.commands.map((c: any) => c.name());
        expect(scheduleVerbs).toEqual(expect.arrayContaining(['set', 'list', 'enable', 'disable', 'reset', 'delete']));

        const deploy = project.commands.find((c: any) => c.name() === 'deploy');
        expect(deploy.options.map((o: any) => o.long)).toContain('--paused');

        const scheduleSet = schedule.commands.find((c: any) => c.name() === 'set');
        expect(scheduleSet.options.map((o: any) => o.long)).toContain('--paused');

        const crew = program.commands.find((c: any) => c.name() === 'crew');
        const crewEnv = crew.commands.find((c: any) => c.name() === 'env');
        expect(crewEnv.commands.map((c: any) => c.name())).toContain('map-database');
    });

    it('exposes the program-level global option', () => {
        const { program } = require(CLI_BINARY);
        const longs = program.options.map((o: any) => o.long);
        expect(longs).toContain('--workspace-override');
    });
});
