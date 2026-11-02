import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { validateProject } from '../src/commands/deploy';

let roots: string[] = [];

afterEach(() => {
    for (const root of roots) {
        fs.rmSync(root, { recursive: true, force: true });
    }
    roots = [];
});

function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-validate-project-'));
    roots.push(dir);
    return dir;
}

function writeProject(root: string, config: unknown): void {
    fs.writeFileSync(path.join(root, 'solidactions.yaml'), yaml.dump(config));
}

function writeFile(root: string, relPath: string, content: string): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

describe('validateProject with pages/functions', () => {
    it('accepts a pages-only project without package.json', () => {
        const dir = makeTmpDir();
        writeProject(dir, {
            project: 'shop',
            pages: [{ id: 'orders', name: 'Orders', file: 'pages/orders.html' }],
        });
        writeFile(dir, 'pages/orders.html', '<html>orders</html>');
        // Precondition: the relaxation is what makes this pass — no node packaging present.
        expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(false);
        const result = validateProject(dir);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('still errors for a workflows project without package.json', () => {
        const dir = makeTmpDir();
        writeProject(dir, {
            project: 'shop',
            workflows: [{ name: 'Nightly', command: 'echo hi' }],
        });
        expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(false);
        const result = validateProject(dir);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('package.json not found. Initialize with: npm init');
    });

    it('fails a yaml that declares nothing with the new message', () => {
        const dir = makeTmpDir();
        writeProject(dir, { project: 'shop' });
        const result = validateProject(dir);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
            'solidactions.yaml must declare at least one of workflows, pages, functions.',
        );
    });

    it('appends item errors as <entry>.<field>: <message>', () => {
        const dir = makeTmpDir();
        writeProject(dir, {
            project: 'shop',
            pages: [{ id: 'ghost', name: 'Ghost', file: 'pages/ghost.html' }],
        });
        // Precondition: the target file is absent, so the not-found rule fires.
        expect(fs.existsSync(path.join(dir, 'pages/ghost.html'))).toBe(false);
        const result = validateProject(dir);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
            'pages[ghost].file: pages[ghost].file: page file "pages/ghost.html" not found.',
        );
    });

    it('errors for an explicit empty workflows list with pages when package.json is missing', () => {
        const dir = makeTmpDir();
        writeProject(dir, {
            project: 'shop',
            workflows: [],
            pages: [{ id: 'orders', name: 'Orders', file: 'pages/orders.html' }],
        });
        writeFile(dir, 'pages/orders.html', '<html>orders</html>');
        // Preconditions: workflows is present as an explicit empty list, the page
        // fixture is valid, and no node packaging exists — so only the retained
        // package.json check fires.
        const loaded = yaml.load(fs.readFileSync(path.join(dir, 'solidactions.yaml'), 'utf8')) as {
            workflows?: unknown;
        };
        expect(loaded.workflows).toEqual([]);
        expect(fs.existsSync(path.join(dir, 'pages/orders.html'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(false);
        const result = validateProject(dir);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('package.json not found. Initialize with: npm init');
    });

    it('errors for an explicit empty workflows list alone when package.json is missing', () => {
        const dir = makeTmpDir();
        writeProject(dir, {
            project: 'shop',
            workflows: [],
        });
        // Preconditions: workflows is present as an explicit empty list and no
        // node packaging exists — the retained checks run instead of the
        // declare-at-least-one error.
        const loaded = yaml.load(fs.readFileSync(path.join(dir, 'solidactions.yaml'), 'utf8')) as {
            workflows?: unknown;
        };
        expect(loaded.workflows).toEqual([]);
        expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(false);
        const result = validateProject(dir);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('package.json not found. Initialize with: npm init');
        expect(result.errors).not.toContain(
            'solidactions.yaml must declare at least one of workflows, pages, functions.',
        );
    });

    it('errors for an explicit empty workflows list when the SDK is missing', () => {
        const dir = makeTmpDir();
        writeProject(dir, {
            project: 'shop',
            workflows: [],
            pages: [{ id: 'orders', name: 'Orders', file: 'pages/orders.html' }],
        });
        writeFile(dir, 'pages/orders.html', '<html>orders</html>');
        writeFile(
            dir,
            'package.json',
            JSON.stringify({ name: 'shop', version: '1.0.0', dependencies: {} }),
        );
        // Preconditions: workflows is present as an explicit empty list, the page
        // fixture and package.json are valid, and no SDK is installed — so only
        // the retained SDK check fires.
        const loaded = yaml.load(fs.readFileSync(path.join(dir, 'solidactions.yaml'), 'utf8')) as {
            workflows?: unknown;
        };
        expect(loaded.workflows).toEqual([]);
        expect(fs.existsSync(path.join(dir, 'pages/orders.html'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'sdk'))).toBe(false);
        const result = validateProject(dir);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
            'Missing SDK in package.json dependencies. Run: npm install @solidactions/sdk',
        );
    });

    it('returns a structured error for a null page entry instead of throwing', () => {
        const dir = makeTmpDir();
        writeProject(dir, {
            project: 'shop',
            pages: [null],
        });
        // Precondition: the yaml holds one non-object page element.
        const loaded = yaml.load(fs.readFileSync(path.join(dir, 'solidactions.yaml'), 'utf8')) as {
            pages?: unknown;
        };
        expect(loaded.pages).toEqual([null]);
        let result!: { valid: boolean; errors: string[]; warnings: string[] };
        expect(() => {
            result = validateProject(dir);
        }).not.toThrow();
        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
            'pages[0].pages: pages[0].pages: page entry must be an object (got null).',
        );
    });

    it('returns a structured error for a null function entry instead of throwing', () => {
        const dir = makeTmpDir();
        writeProject(dir, {
            project: 'shop',
            functions: [null],
        });
        // Precondition: the yaml holds one non-object function element.
        const loaded = yaml.load(fs.readFileSync(path.join(dir, 'solidactions.yaml'), 'utf8')) as {
            functions?: unknown;
        };
        expect(loaded.functions).toEqual([null]);
        let result!: { valid: boolean; errors: string[]; warnings: string[] };
        expect(() => {
            result = validateProject(dir);
        }).not.toThrow();
        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
            'functions[0].functions: functions[0].functions: function entry must be an object (got null).',
        );
    });

    it('returns a structured error for a null workflow entry instead of throwing', () => {
        const dir = makeTmpDir();
        writeProject(dir, {
            project: 'shop',
            workflows: [null],
        });
        writeFile(
            dir,
            'package.json',
            JSON.stringify({
                name: 'shop',
                version: '1.0.0',
                dependencies: { '@solidactions/sdk': '^1.0.0' },
            }),
        );
        // Preconditions: the yaml holds one non-object workflow element and the
        // packaging is valid, so validation reaches the workflow loop.
        const loaded = yaml.load(fs.readFileSync(path.join(dir, 'solidactions.yaml'), 'utf8')) as {
            workflows?: unknown;
        };
        expect(loaded.workflows).toEqual([null]);
        expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);
        let result!: { valid: boolean; errors: string[]; warnings: string[] };
        expect(() => {
            result = validateProject(dir);
        }).not.toThrow();
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Workflow entry must be an object with a 'name' field.");
    });
});
