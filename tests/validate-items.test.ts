import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isPagePointer, validateItems } from '../src/utils/validate-items';
import type { FunctionCodeEntry, FunctionEntry, PageEntry, SolidActionsConfig } from '../src/utils/env';
import type { ItemError } from '../src/utils/validate-items';

let roots: string[] = [];

afterEach(() => {
    for (const root of roots) {
        fs.rmSync(root, { recursive: true, force: true });
    }
    roots = [];
});

function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-items-'));
    roots.push(dir);
    return dir;
}

function writeFile(root: string, relPath: string, content: string | Buffer): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

describe('validateItems', () => {
    it('returns [] for a valid two-page config', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'pages/orders.html', '<html>orders</html>');
        writeFile(dir, 'pages/board.tsx', 'export default function Board() { return null; }');
        const config: SolidActionsConfig = {
            project: 'shop',
            pages: [
                { id: 'orders', name: 'Orders', file: 'pages/orders.html', home: true },
                { id: 'board', name: 'Board', file: 'pages/board.tsx' },
            ],
        };
        expect(validateItems(config, dir)).toEqual([]);
    });

    it('rejects a duplicate page slug', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'pages/a.html', '<html>a</html>');
        // Precondition: the shared file exists, so only the slug rule fires.
        expect(fs.existsSync(path.join(dir, 'pages/a.html'))).toBe(true);
        const config: SolidActionsConfig = {
            pages: [
                { id: 'orders', name: 'Orders', file: 'pages/a.html' },
                { id: 'orders', name: 'Orders again', file: 'pages/a.html' },
            ],
        };
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'pages[orders]',
            field: 'id',
            message: 'pages[orders].id: duplicate page slug "orders" (already used by pages[orders]).',
        });
    });

    it('rejects a function slug equal to a workflow slug', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'functions/enrich-lead.ts', 'export async function run() {}');
        // Precondition: the function file exists, so only the slug rule fires.
        expect(fs.existsSync(path.join(dir, 'functions/enrich-lead.ts'))).toBe(true);
        const config: SolidActionsConfig = {
            workflows: [{ name: 'Enrich Lead', command: 'echo hi' }],
            functions: [{ id: 'enrich-lead', name: 'Enrich Lead', file: 'functions/enrich-lead.ts' }],
        };
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'functions[enrich-lead]',
            field: 'id',
            message: 'functions[enrich-lead].id: function slug "enrich-lead" is already used by a workflow.',
        });
    });

    it('rejects a .md page file even when the file exists', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'pages/notes.md', '# notes');
        // Precondition: the failure is the extension rule, not a missing file.
        expect(fs.existsSync(path.join(dir, 'pages/notes.md'))).toBe(true);
        const config: SolidActionsConfig = {
            pages: [{ id: 'notes', name: 'Notes', file: 'pages/notes.md' }],
        };
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'pages[notes]',
            field: 'file',
            message: 'pages[notes].file: page file "pages/notes.md" must end in .html or .tsx.',
        });
    });

    it('rejects a 2 MB html page file', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'pages/big.html', Buffer.alloc(2 * 1024 * 1024, 'a'));
        // Precondition: the fixture really is 2 MB, so the size rule fires.
        expect(fs.statSync(path.join(dir, 'pages/big.html')).size).toBe(2 * 1024 * 1024);
        const config: SolidActionsConfig = {
            pages: [{ id: 'big', name: 'Big', file: 'pages/big.html' }],
        };
        const errors = validateItems(config, dir);
        expect(errors).toHaveLength(1);
        expect(errors[0].entry).toBe('pages[big]');
        expect(errors[0].field).toBe('file');
        expect(errors[0].message).toContain('pages[big]');
        expect(errors[0].message).toContain('file');
        expect(errors[0].message).toContain('1 MB');
    });

    it('rejects two pages with home: true', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'pages/a.html', '<html>a</html>');
        // Precondition: the shared file exists, so only the home rule fires.
        expect(fs.existsSync(path.join(dir, 'pages/a.html'))).toBe(true);
        const config: SolidActionsConfig = {
            pages: [
                { id: 'a', name: 'A', file: 'pages/a.html', home: true },
                { id: 'b', name: 'B', file: 'pages/a.html', home: true },
            ],
        };
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'pages[b]',
            field: 'home',
            message: 'pages[b].home: at most one page may have home: true (already set on pages[a]).',
        });
    });

    it('rejects a pointer with a file:', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'pages/review.html', '<html>review</html>');
        // Precondition: the named file exists, so the pointer rule fires, not absence.
        expect(fs.existsSync(path.join(dir, 'pages/review.html'))).toBe(true);
        const pointer = {
            id: 2242,
            name: 'Review queue',
            owner: 'editor',
            file: 'pages/review.html',
        } as unknown as PageEntry;
        const config: SolidActionsConfig = { pages: [pointer] };
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'pages[2242]',
            field: 'file',
            message: "pages[2242].file: a page made in the app (owner: editor) can't have a file: \"pages/review.html\".",
        });
    });

    it('rejects a missing page file', () => {
        const dir = makeTmpDir();
        const config: SolidActionsConfig = {
            pages: [{ id: 'ghost', name: 'Ghost', file: 'pages/ghost.html' }],
        };
        // Precondition: the target file is absent, so the not-found rule fires.
        expect(fs.existsSync(path.join(dir, 'pages/ghost.html'))).toBe(false);
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'pages[ghost]',
            field: 'file',
            message: 'pages[ghost].file: page file "pages/ghost.html" not found.',
        });
    });

    it('rejects an uppercase slug', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'pages/orders.html', '<html>orders</html>');
        // Precondition: the file exists, so only the slug rule fires.
        expect(fs.existsSync(path.join(dir, 'pages/orders.html'))).toBe(true);
        const config: SolidActionsConfig = {
            pages: [{ id: 'Orders', name: 'Orders', file: 'pages/orders.html' }],
        };
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'pages[Orders]',
            field: 'id',
            message: 'pages[Orders].id: invalid slug "Orders" — slugs must match [a-z0-9][a-z0-9-]{0,62}.',
        });
    });

    it('rejects 51 pages', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'pages/a.html', '<html>a</html>');
        const config: SolidActionsConfig = {
            pages: Array.from({ length: 51 }, (_, i) => ({
                id: `page-${i}`,
                name: `Page ${i}`,
                file: 'pages/a.html',
            })),
        };
        // Precondition: one shared real file and 51 entries, so only the cap fires.
        expect(fs.existsSync(path.join(dir, 'pages/a.html'))).toBe(true);
        expect(config.pages).toHaveLength(51);
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'pages',
            field: 'pages',
            message: 'pages: at most 50 pages per project (got 51).',
        });
    });

    it('accepts a pointer without a file and skips the slug rule for it', () => {
        const dir = makeTmpDir();
        const config: SolidActionsConfig = {
            pages: [{ id: 2242, name: 'Review queue', owner: 'editor' }],
        };
        expect(validateItems(config, dir)).toEqual([]);
    });

    it('isPagePointer narrows on owner: editor', () => {
        const pointer: PageEntry = { id: 2242, name: 'Review queue', owner: 'editor' };
        const code: PageEntry = { id: 'orders', name: 'Orders', file: 'pages/orders.html' };
        expect(isPagePointer(pointer)).toBe(true);
        expect(isPagePointer(code)).toBe(false);
    });

    it('returns a structured error for a null page entry instead of throwing', () => {
        const dir = makeTmpDir();
        const config: SolidActionsConfig = {
            pages: [null] as unknown as PageEntry[],
        };
        // Precondition: the list holds one non-object element, so the shape guard fires.
        expect(Array.isArray(config.pages)).toBe(true);
        expect(config.pages).toHaveLength(1);
        let errors!: ItemError[];
        expect(() => {
            errors = validateItems(config, dir);
        }).not.toThrow();
        expect(errors).toContainEqual({
            entry: 'pages[0]',
            field: 'pages',
            message: 'pages[0].pages: page entry must be an object (got null).',
        });
    });

    it('returns a structured error for a null function entry instead of throwing', () => {
        const dir = makeTmpDir();
        const config: SolidActionsConfig = {
            functions: [null] as unknown as FunctionEntry[],
        };
        // Precondition: the list holds one non-object element, so the shape guard fires.
        expect(Array.isArray(config.functions)).toBe(true);
        expect(config.functions).toHaveLength(1);
        let errors!: ItemError[];
        expect(() => {
            errors = validateItems(config, dir);
        }).not.toThrow();
        expect(errors).toContainEqual({
            entry: 'functions[0]',
            field: 'functions',
            message: 'functions[0].functions: function entry must be an object (got null).',
        });
    });

    it('returns a structured error for a null workflow entry instead of throwing', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'pages/orders.html', '<html>orders</html>');
        // Precondition: the page fixture is valid, so only the workflow guard fires.
        expect(fs.existsSync(path.join(dir, 'pages/orders.html'))).toBe(true);
        const config: SolidActionsConfig = {
            workflows: [null] as unknown as NonNullable<SolidActionsConfig['workflows']>,
            pages: [{ id: 'orders', name: 'Orders', file: 'pages/orders.html' }],
        };
        let errors!: ItemError[];
        expect(() => {
            errors = validateItems(config, dir);
        }).not.toThrow();
        expect(errors).toHaveLength(1);
        expect(errors).toContainEqual({
            entry: 'workflows[0]',
            field: 'workflows',
            message: 'workflows[0].workflows: workflow entry must be an object (got null).',
        });
    });

    it('returns [] for a valid function-only config', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'functions/enrich-lead.ts', 'export async function run() {}');
        // Precondition: the function file exists with a valid extension and size.
        expect(fs.existsSync(path.join(dir, 'functions/enrich-lead.ts'))).toBe(true);
        const config: SolidActionsConfig = {
            project: 'shop',
            functions: [
                {
                    id: 'enrich-lead',
                    name: 'Enrich Lead',
                    file: 'functions/enrich-lead.ts',
                    timeout: 10,
                    webhook_auth: 'hmac',
                },
            ],
        };
        expect(validateItems(config, dir)).toEqual([]);
    });

    it('rejects a duplicate function slug', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'functions/a.ts', 'export async function run() {}');
        // Precondition: the shared file exists, so only the slug rule fires.
        expect(fs.existsSync(path.join(dir, 'functions/a.ts'))).toBe(true);
        const config: SolidActionsConfig = {
            functions: [
                { id: 'dup', name: 'Dup', file: 'functions/a.ts' },
                { id: 'dup', name: 'Dup again', file: 'functions/a.ts' },
            ],
        };
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'functions[dup]',
            field: 'id',
            message: 'functions[dup].id: duplicate function slug "dup" (already used by functions[dup]).',
        });
    });

    it('rejects a function file that does not end in .ts', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'functions/run.js', 'module.exports = {};');
        // Precondition: the failure is the extension rule, not a missing file.
        expect(fs.existsSync(path.join(dir, 'functions/run.js'))).toBe(true);
        const config: SolidActionsConfig = {
            functions: [{ id: 'run', name: 'Run', file: 'functions/run.js' }],
        };
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'functions[run]',
            field: 'file',
            message: 'functions[run].file: function file "functions/run.js" must end in .ts.',
        });
    });

    it('rejects a function timeout outside 1..30', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'functions/ping.ts', 'export async function run() {}');
        // Precondition: the file is valid, so only the timeout rule fires.
        expect(fs.existsSync(path.join(dir, 'functions/ping.ts'))).toBe(true);
        const config: SolidActionsConfig = {
            functions: [{ id: 'ping', name: 'Ping', file: 'functions/ping.ts', timeout: 99 }],
        };
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'functions[ping]',
            field: 'timeout',
            message: 'functions[ping].timeout: timeout must be between 1 and 30 seconds (got 99).',
        });
    });

    it('rejects an unknown function webhook_auth', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'functions/hook.ts', 'export async function run() {}');
        // Precondition: the file is valid, so only the webhook_auth rule fires.
        expect(fs.existsSync(path.join(dir, 'functions/hook.ts'))).toBe(true);
        const entry = {
            id: 'hook',
            name: 'Hook',
            file: 'functions/hook.ts',
            webhook_auth: 'oauth',
        } as unknown as FunctionCodeEntry;
        const config: SolidActionsConfig = { functions: [entry] };
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'functions[hook]',
            field: 'webhook_auth',
            message: 'functions[hook].webhook_auth: webhook_auth must be one of hmac, basic, header, none (got "oauth").',
        });
    });

    it('rejects 51 functions', () => {
        const dir = makeTmpDir();
        writeFile(dir, 'functions/a.ts', 'export async function run() {}');
        const config: SolidActionsConfig = {
            functions: Array.from({ length: 51 }, (_, i) => ({
                id: `fn-${i}`,
                name: `Fn ${i}`,
                file: 'functions/a.ts',
            })),
        };
        // Precondition: one shared real file and 51 entries, so only the cap fires.
        expect(fs.existsSync(path.join(dir, 'functions/a.ts'))).toBe(true);
        expect(config.functions).toHaveLength(51);
        const errors = validateItems(config, dir);
        expect(errors).toContainEqual({
            entry: 'functions',
            field: 'functions',
            message: 'functions: at most 50 functions per project (got 51).',
        });
    });
});
