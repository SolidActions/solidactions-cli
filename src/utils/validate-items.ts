import fs from 'fs';
import path from 'path';
import type { FunctionEntry, PageEntry, PagePointerEntry, SolidActionsConfig } from './env';
import { slugifyName } from './slug';

export interface ItemError { entry: string; field: string; message: string; }

export function isPagePointer(e: PageEntry): e is PagePointerEntry {
    return (e as PagePointerEntry).owner === 'editor';
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_PAGES = 50;
const MAX_FUNCTIONS = 50;
const MAX_PAGE_FILE_BYTES = 1024 * 1024;
const MAX_FUNCTION_FILE_BYTES = 256 * 1024;
const PAGE_EXTENSIONS = ['.html', '.tsx'];
const WEBHOOK_AUTHS = ['hmac', 'basic', 'header', 'none'];

function label(kind: 'pages' | 'functions' | 'workflows', id: unknown, index: number): string {
    return `${kind}[${String(id ?? index)}]`;
}

function describeReceived(value: unknown): string {
    return JSON.stringify(value) ?? typeof value;
}

function isEditorOwned(entry: PageEntry | FunctionEntry): boolean {
    return (entry as { owner?: unknown }).owner === 'editor';
}

function checkFile(
    sourceDir: string,
    kind: 'pages' | 'functions',
    entryLabel: string,
    file: unknown,
    allowedExtensions: string[],
    maxBytes: number,
    limitName: string,
): ItemError[] {
    const noun = kind === 'pages' ? 'page file' : 'function file';
    if (typeof file !== 'string' || file === '') {
        return [{ entry: entryLabel, field: 'file', message: `${entryLabel}.file: ${noun} is required.` }];
    }
    if (!allowedExtensions.includes(path.extname(file))) {
        return [{ entry: entryLabel, field: 'file', message: `${entryLabel}.file: ${noun} "${file}" must end in ${allowedExtensions.join(' or ')}.` }];
    }
    let stat: fs.Stats;
    try {
        stat = fs.statSync(path.join(sourceDir, file));
    } catch {
        return [{ entry: entryLabel, field: 'file', message: `${entryLabel}.file: ${noun} "${file}" not found.` }];
    }
    if (!stat.isFile()) {
        return [{ entry: entryLabel, field: 'file', message: `${entryLabel}.file: ${noun} "${file}" is not a file.` }];
    }
    if (stat.size > maxBytes) {
        return [{ entry: entryLabel, field: 'file', message: `${entryLabel}.file: ${noun} "${file}" is ${stat.size} bytes, over the ${limitName} limit.` }];
    }
    return [];
}

export function validateItems(config: SolidActionsConfig, sourceDir: string): ItemError[] {
    const errors: ItemError[] = [];

    if (config.pages !== undefined && !Array.isArray(config.pages)) {
        errors.push({ entry: 'pages', field: 'pages', message: 'pages: pages must be a list.' });
    }
    if (config.functions !== undefined && !Array.isArray(config.functions)) {
        errors.push({ entry: 'functions', field: 'functions', message: 'functions: functions must be a list.' });
    }
    const pages: PageEntry[] = Array.isArray(config.pages) ? config.pages : [];
    const functions: FunctionEntry[] = Array.isArray(config.functions) ? config.functions : [];

    if (pages.length > MAX_PAGES) {
        errors.push({ entry: 'pages', field: 'pages', message: `pages: at most 50 pages per project (got ${pages.length}).` });
    }
    if (functions.length > MAX_FUNCTIONS) {
        errors.push({ entry: 'functions', field: 'functions', message: `functions: at most 50 functions per project (got ${functions.length}).` });
    }

    const seenPageSlugs = new Map<string, string>();
    let firstHomeLabel: string | null = null;
    pages.forEach((entry, index) => {
        if (typeof entry !== 'object' || entry === null) {
            const entryLabel = label('pages', undefined, index);
            errors.push({ entry: entryLabel, field: 'pages', message: `${entryLabel}.pages: page entry must be an object (got ${describeReceived(entry)}).` });
            return;
        }
        const rawId = (entry as { id?: unknown }).id;
        const entryLabel = label('pages', rawId, index);
        if (isEditorOwned(entry)) {
            const file = (entry as { file?: unknown }).file;
            if (file !== undefined) {
                errors.push({ entry: entryLabel, field: 'file', message: `${entryLabel}.file: a page made in the app (owner: editor) can't have a file: "${String(file)}".` });
            }
            return;
        }
        if (typeof rawId !== 'string' || !SLUG_RE.test(rawId)) {
            errors.push({ entry: entryLabel, field: 'id', message: `${entryLabel}.id: invalid slug "${String(rawId)}" — slugs must match [a-z0-9][a-z0-9-]{0,62}.` });
        } else if (seenPageSlugs.has(rawId)) {
            errors.push({ entry: entryLabel, field: 'id', message: `${entryLabel}.id: duplicate page slug "${rawId}" (already used by ${seenPageSlugs.get(rawId)}).` });
        } else {
            seenPageSlugs.set(rawId, entryLabel);
        }
        if ((entry as { home?: unknown }).home === true) {
            if (firstHomeLabel === null) {
                firstHomeLabel = entryLabel;
            } else {
                errors.push({ entry: entryLabel, field: 'home', message: `${entryLabel}.home: at most one page may have home: true (already set on ${firstHomeLabel}).` });
            }
        }
        errors.push(...checkFile(sourceDir, 'pages', entryLabel, (entry as { file?: unknown }).file, PAGE_EXTENSIONS, MAX_PAGE_FILE_BYTES, '1 MB'));
    });

    const workflows = Array.isArray(config.workflows) ? config.workflows : [];
    const workflowSlugs = new Set<string>();
    for (const [index, wf] of workflows.entries()) {
        if (typeof wf !== 'object' || wf === null) {
            const entryLabel = label('workflows', undefined, index);
            errors.push({ entry: entryLabel, field: 'workflows', message: `${entryLabel}.workflows: workflow entry must be an object (got ${describeReceived(wf)}).` });
            continue;
        }
        if (typeof wf.id === 'string' && wf.id !== '') {
            workflowSlugs.add(wf.id);
        }
        if (typeof wf.name === 'string' && wf.name !== '') {
            const slug = slugifyName(wf.name);
            if (slug !== '') {
                workflowSlugs.add(slug);
            }
        }
    }

    const seenFunctionSlugs = new Map<string, string>();
    functions.forEach((entry, index) => {
        if (typeof entry !== 'object' || entry === null) {
            const entryLabel = label('functions', undefined, index);
            errors.push({ entry: entryLabel, field: 'functions', message: `${entryLabel}.functions: function entry must be an object (got ${describeReceived(entry)}).` });
            return;
        }
        const rawId = (entry as { id?: unknown }).id;
        const entryLabel = label('functions', rawId, index);
        if (isEditorOwned(entry)) {
            const file = (entry as { file?: unknown }).file;
            if (file !== undefined) {
                errors.push({ entry: entryLabel, field: 'file', message: `${entryLabel}.file: a function made in the app (owner: editor) can't have a file: "${String(file)}".` });
            }
            return;
        }
        if (typeof rawId !== 'string' || !SLUG_RE.test(rawId)) {
            errors.push({ entry: entryLabel, field: 'id', message: `${entryLabel}.id: invalid slug "${String(rawId)}" — slugs must match [a-z0-9][a-z0-9-]{0,62}.` });
        } else {
            if (seenFunctionSlugs.has(rawId)) {
                errors.push({ entry: entryLabel, field: 'id', message: `${entryLabel}.id: duplicate function slug "${rawId}" (already used by ${seenFunctionSlugs.get(rawId)}).` });
            } else {
                seenFunctionSlugs.set(rawId, entryLabel);
            }
            if (workflowSlugs.has(rawId)) {
                errors.push({ entry: entryLabel, field: 'id', message: `${entryLabel}.id: function slug "${rawId}" is already used by a workflow.` });
            }
        }
        errors.push(...checkFile(sourceDir, 'functions', entryLabel, (entry as { file?: unknown }).file, ['.ts'], MAX_FUNCTION_FILE_BYTES, '256 KB'));
        const timeout = (entry as { timeout?: unknown }).timeout;
        if (timeout !== undefined && (typeof timeout !== 'number' || Number.isNaN(timeout) || timeout < 1 || timeout > 30)) {
            errors.push({ entry: entryLabel, field: 'timeout', message: `${entryLabel}.timeout: timeout must be between 1 and 30 seconds (got ${JSON.stringify(timeout)}).` });
        }
        const webhookAuth = (entry as { webhook_auth?: unknown }).webhook_auth;
        if (webhookAuth !== undefined && (typeof webhookAuth !== 'string' || !WEBHOOK_AUTHS.includes(webhookAuth))) {
            errors.push({ entry: entryLabel, field: 'webhook_auth', message: `${entryLabel}.webhook_auth: webhook_auth must be one of hmac, basic, header, none (got ${JSON.stringify(webhookAuth)}).` });
        }
    });

    return errors;
}
