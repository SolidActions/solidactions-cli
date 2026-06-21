import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { cacheBusterEntry } from '../src/commands/deploy';

// ---------------------------------------------------------------------------
// cacheBusterEntry helper — pure unit tests
// ---------------------------------------------------------------------------

describe('cacheBusterEntry', () => {
    it('returns null when noCache is false', () => {
        expect(cacheBusterEntry(false)).toBeNull();
    });

    it('returns a non-null entry when noCache is true', () => {
        const entry = cacheBusterEntry(true);
        expect(entry).not.toBeNull();
    });

    it('entry name starts with tenantcode/sa-nocache-', () => {
        const entry = cacheBusterEntry(true)!;
        expect(entry.name).toMatch(/^tenantcode\/sa-nocache-/);
    });

    it('entry content contains the uuid from the name', () => {
        const entry = cacheBusterEntry(true)!;
        // The uuid is the suffix after "tenantcode/sa-nocache-"
        const uuid = entry.name.replace('tenantcode/sa-nocache-', '');
        expect(entry.content).toContain(uuid);
    });

    it('two consecutive calls produce different names and different content', () => {
        const a = cacheBusterEntry(true)!;
        const b = cacheBusterEntry(true)!;
        expect(a.name).not.toBe(b.name);
        expect(a.content).not.toBe(b.content);
    });
});

// ---------------------------------------------------------------------------
// Commander flag parsing — verify the --no-cache negation gotcha
// ---------------------------------------------------------------------------

describe('--no-cache / --force-rebuild flag parsing', () => {
    function parseDeployOpts(args: string[]): { cache?: boolean; forceRebuild?: boolean } {
        const cmd = new Command();
        cmd.option('--no-cache', 'Force fresh build');
        cmd.option('--force-rebuild', 'Force fresh build alias');
        // parseCommand sets exitOverride so errors throw instead of process.exit
        cmd.exitOverride();
        cmd.parse(['node', 'deploy', ...args]);
        return cmd.opts() as { cache?: boolean; forceRebuild?: boolean };
    }

    it('--no-cache sets cache === false (Commander negation convention, NOT noCache)', () => {
        const opts = parseDeployOpts(['--no-cache']);
        expect(opts.cache).toBe(false);
        // Confirm there is no "noCache" property — the gotcha we guard against
        expect((opts as any).noCache).toBeUndefined();
    });

    it('--force-rebuild sets forceRebuild === true', () => {
        const opts = parseDeployOpts(['--force-rebuild']);
        expect(opts.forceRebuild).toBe(true);
    });

    it('neither flag: cache defaults to true, forceRebuild is undefined', () => {
        const opts = parseDeployOpts([]);
        // Commander initializes --no-X pairs with the positive side as true by default
        expect(opts.cache).toBe(true);
        expect(opts.forceRebuild).toBeUndefined();
    });

    it('normalization: cache===false resolves to noCache=true', () => {
        const opts = parseDeployOpts(['--no-cache']);
        const noCache = opts.cache === false || opts.forceRebuild === true;
        expect(noCache).toBe(true);
    });

    it('normalization: forceRebuild===true resolves to noCache=true', () => {
        const opts = parseDeployOpts(['--force-rebuild']);
        const noCache = opts.cache === false || opts.forceRebuild === true;
        expect(noCache).toBe(true);
    });

    it('normalization: no flags resolves to noCache=false', () => {
        const opts = parseDeployOpts([]);
        const noCache = opts.cache === false || opts.forceRebuild === true;
        expect(noCache).toBe(false);
    });
});
