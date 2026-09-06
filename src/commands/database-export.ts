import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import * as readline from 'readline';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { Config } from '../utils/config';
import { DatabaseOperationError } from '../utils/database-data-plane';
import { requestDatabaseRecord } from './database';

export interface DatabaseExportOptions {
    table?: string[];
    output?: string;
    wait?: boolean;
    resume?: string;
    replace?: boolean;
    json?: boolean;
}

export interface DatabaseExportResult {
    export_id: string;
    state: string;
    created_at: string;
    expires_at?: string | null;
    directory: string;
    files: Array<{ table?: string; filename: string; path: string; bytes: number; sha256: string }>;
}

interface ExportDependencies {
    cwd?: string;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    isTTY?: boolean;
    confirm?: (message: string) => Promise<boolean>;
    sleep?: (milliseconds: number) => Promise<void>;
}

interface ExportMetadata {
    export_id: string;
    state: string;
    created_at: string;
    expires_at?: string | null;
    manifest_digest?: string | null;
    error_code?: string | null;
    error_message?: string | null;
    retry_after_ms?: number;
}

interface ExportDownload {
    table?: string;
    filename: string;
    bytes?: number;
    sha256?: string;
    digest?: string;
    url: string;
}

interface ExportDownloads {
    export_id: string;
    expires_at?: string | null;
    manifest: ExportDownload;
    files: ExportDownload[];
}

function safeDownloadUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
        return false;
    }
}

function refreshedDownload(listing: ExportDownloads, exportId: string, expected: ExportDownload): ExportDownload | null {
    if (!listing || listing.export_id !== exportId) return null;
    const fresh = expected.filename === 'manifest.json'
        ? listing.manifest
        : Array.isArray(listing.files) ? listing.files.find((file) => file.filename === expected.filename) : undefined;
    if (
        !fresh || fresh.filename !== expected.filename || !safeDownloadUrl(fresh.url)
        || fresh.table !== expected.table || fresh.bytes !== expected.bytes
        || fresh.sha256 !== expected.sha256 || fresh.digest !== expected.digest
    ) return null;
    return { ...expected, url: fresh.url };
}

class ExportCommandError extends DatabaseOperationError {
    readonly exportId?: string;

    constructor(code: string, message: string, status?: number, exportId?: string) {
        super(code, message, status);
        this.exportId = exportId;
    }
}

function normalizeTables(tables: string[] | undefined): string[] | undefined {
    if (!tables || tables.length === 0) return undefined;
    const normalized = [...new Set(tables.map((table) => table.trim().toLowerCase()))].sort();
    for (const table of normalized) {
        if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) {
            throw new ExportCommandError('table_not_found', `Table "${table}" does not exist.`);
        }
    }
    return normalized;
}

function stableMetadata(value: unknown): ExportMetadata {
    const row = value as Partial<ExportMetadata> | null;
    if (
        !row || typeof row.export_id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.export_id)
        || typeof row.state !== 'string' || !['queued', 'running', 'finalizing', 'ready', 'failed', 'expired'].includes(row.state)
        || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
        || (row.manifest_digest != null && (typeof row.manifest_digest !== 'string' || !/^[0-9a-f]{64}$/.test(row.manifest_digest)))
    ) {
        throw new ExportCommandError('upstream_unavailable', 'The export response was invalid.');
    }
    return row as ExportMetadata;
}

function applyRetryAfter<T>(data: T, retryAfter: unknown): T {
    if (!data || typeof data !== 'object' || Array.isArray(data) || retryAfter === undefined) return data;
    const seconds = Number(retryAfter);
    const retryAfterMs = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1_000)
        : Math.max(0, Date.parse(String(retryAfter)) - Date.now());
    if (Number.isFinite(retryAfterMs)) (data as Record<string, unknown>).retry_after_ms = retryAfterMs;
    return data;
}

function safeStem(name: string): string {
    return name.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'database';
}

function timestamp(createdAt: string): string {
    const parsed = new Date(createdAt);
    if (!Number.isFinite(parsed.getTime())) throw new ExportCommandError('upstream_unavailable', 'The export response was invalid.');
    return parsed.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function defaultDirectory(cwd: string, database: string, metadata: ExportMetadata): string {
    return path.join(cwd, `${safeStem(database)}-${timestamp(metadata.created_at)}-${metadata.export_id.replace(/-/g, '').slice(0, 8)}`);
}

async function directoryIsEmpty(directory: string): Promise<boolean> {
    try {
        return (await fs.promises.readdir(directory)).length === 0;
    } catch (error: any) {
        if (error?.code === 'ENOENT') return true;
        throw error;
    }
}

async function assertSafeDirectory(directory: string): Promise<void> {
    const absolute = path.resolve(directory);
    const parsed = path.parse(absolute);
    let cursor = parsed.root;
    for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        try {
            const stat = await fs.promises.lstat(cursor);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new ExportCommandError('unsafe_destination', `Export destination is unsafe: ${directory}`);
            }
        } catch (error: any) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
    }
}

async function confirm(message: string): Promise<boolean> {
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    return await new Promise((resolve) => input.question(`${message} [y/N] `, (answer) => {
        input.close();
        resolve(/^y(?:es)?$/i.test(answer.trim()));
    }));
}

function teachingError(error: unknown): never {
    const value = error as { code?: string; message?: string; status?: number; exportId?: string };
    const id = value.exportId;
    if (value.code === 'export_expired') {
        throw new ExportCommandError('export_expired', 'This export has expired. Start a new export without --resume.', value.status, id);
    }
    if (value.code === 'export_in_progress') {
        throw new ExportCommandError(value.code, `${value.message ?? 'An export is already being prepared.'}${id ? ` Rerun with --resume ${id}.` : ''}`, value.status, id);
    }
    throw error;
}

async function operation<T>(config: Config, body: Record<string, unknown>): Promise<T> {
    try {
        const response = await axios.post(`${config.host}/api/v1/databases`, body, {
            headers: getApiHeaders(config, 'application/json'),
            timeout: 30_000,
        });
        return applyRetryAfter(response.data as T, response.headers['retry-after']);
    } catch (error: any) {
        const response = error?.response;
        const code = typeof response?.data?.code === 'string' ? response.data.code : 'upstream_unavailable';
        const message = typeof response?.data?.message === 'string' ? response.data.message : 'Database request failed.';
        const id = response?.data?.export_id ?? response?.data?.current_export_id;
        throw new ExportCommandError(code, message, response?.status, typeof id === 'string' ? id : undefined);
    }
}

async function startExport(config: Config, name: string, tables: string[] | undefined, replace: boolean, requestId: string): Promise<ExportMetadata> {
    // This call is kept local instead of going through requestDatabaseOperation
    // because replacement errors carry the authorized current export id needed
    // for an actionable CLI decision.
    try {
        const response = await axios.post(`${config.host}/api/v1/databases`, {
            operation: 'export', name, request_id: requestId, ...(tables ? { tables } : {}), replace,
        }, { headers: getApiHeaders(config, 'application/json'), timeout: 30_000 });
        return stableMetadata(applyRetryAfter(response.data, response.headers['retry-after']));
    } catch (error: any) {
        const data = error?.response?.data;
        const code = typeof data?.code === 'string' ? data.code : 'upstream_unavailable';
        const message = typeof data?.message === 'string' ? data.message : 'Database request failed.';
        const exportId = data?.current_export_id ?? data?.export_id;
        throw new ExportCommandError(code, message, error?.response?.status, typeof exportId === 'string' ? exportId : undefined);
    }
}

async function hashFile(file: string): Promise<{ bytes: number; sha256: string } | null> {
    try {
        const stat = await fs.promises.lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new ExportCommandError('unsafe_destination', `Existing export target is unsafe: ${file}`);
        }
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of fs.createReadStream(file)) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            hash.update(buffer);
        }
        return { bytes, sha256: hash.digest('hex') };
    } catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function download(download: ExportDownload, target: string): Promise<{ bytes: number; sha256: string }> {
    const partial = `${target}.part`;
    await fs.promises.rm(partial, { force: true });
    const response = await axios.get(download.url, { responseType: 'stream', validateStatus: () => true });
    if (response.status === 403) {
        response.data.destroy?.();
        const error: any = new Error('The download URL expired.');
        error.status = 403;
        throw error;
    }
    if (response.status < 200 || response.status >= 300) {
        response.data.destroy?.();
        throw new ExportCommandError('download_failed', `Download failed with HTTP ${response.status}.`);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
    } });
    try {
        await pipeline(response.data, meter, fs.createWriteStream(partial, { flags: 'wx' }));
        const sha256 = hash.digest('hex');
        const contentLength = response.headers['content-length'];
        const headerLength = typeof contentLength === 'string' && /^\d+$/.test(contentLength) ? Number(contentLength) : Number.NaN;
        if (!Number.isSafeInteger(headerLength) || headerLength !== bytes) throw new ExportCommandError('download_corrupt', `Content-Length verification failed for ${download.filename}.`);
        if (download.bytes !== undefined && download.bytes !== bytes) throw new ExportCommandError('download_corrupt', `Byte-length verification failed for ${download.filename}.`);
        const expectedDigest = download.sha256 ?? download.digest;
        if (!expectedDigest || !/^[0-9a-f]{64}$/.test(expectedDigest) || sha256 !== expectedDigest) throw new ExportCommandError('download_corrupt', `SHA-256 verification failed for ${download.filename}.`);
        try {
            await fs.promises.lstat(target);
            throw new ExportCommandError('output_exists', `The CLI will not overwrite ${target}.`);
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
        }
        await fs.promises.rename(partial, target);
        return { bytes, sha256 };
    } catch (error) {
        await fs.promises.rm(partial, { force: true });
        throw error;
    }
}

export async function databaseExportWithConfig(
    name: string,
    options: DatabaseExportOptions,
    config: Config,
    dependencies: ExportDependencies = {},
): Promise<DatabaseExportResult> {
    const stdout = dependencies.stdout ?? console.log;
    const stderr = dependencies.stderr ?? console.error;
    const cwd = dependencies.cwd ?? process.cwd();
    const tables = normalizeTables(options.table);
    if (options.resume && tables) throw new ExportCommandError('invalid_arguments', '--table cannot be combined with --resume. A resumed shared export downloads the full artifact.');
    if (options.resume && options.replace) throw new ExportCommandError('invalid_arguments', '--replace cannot be combined with --resume. Resume never creates or replaces an export.');
    if (options.resume && options.wait === false) throw new ExportCommandError('invalid_arguments', '--no-wait cannot be combined with --resume. Resume waits for and downloads the existing export.');

    const database = await requestDatabaseRecord(name, config);
    if (database.kind !== 'duckdb') throw new ExportCommandError('kind_mismatch', `"${name}" is not an analytical database — \`database export\` only works on analytical (duckdb) databases.`);

    let metadata: ExportMetadata;
    if (options.resume) {
        try {
            metadata = stableMetadata(await operation(config, { operation: 'export_status', name, export_id: options.resume }));
        } catch (error) {
            teachingError(error);
        }
    } else {
        const requestId = randomUUID();
        if (!options.json) stderr('Preparing export… New loads pause while the snapshot is prepared and compute uses organisation credits.');
        try {
            metadata = await startExport(config, name, tables, options.replace === true, requestId);
        } catch (error) {
            const value = error as ExportCommandError;
            if (value.code === 'export_replace_required') {
                if (options.replace) throw error;
                if (!(dependencies.isTTY ?? process.stdin.isTTY === true)) {
                    throw new ExportCommandError(value.code, `A ready export must be replaced. Rerun with --replace.${value.exportId ? ` Current export: ${value.exportId}.` : ''}`, value.status, value.exportId);
                }
                if (!await (dependencies.confirm ?? confirm)('This replaces your current export. Continue?')) {
                    stdout('Cancelled.');
                    return { export_id: value.exportId ?? '', state: 'cancelled', created_at: '', directory: '', files: [] };
                }
                metadata = await startExport(config, name, tables, true, requestId);
            } else {
                teachingError(error);
            }
        }
    }

    if (options.wait === false) {
        if (options.json) stdout(JSON.stringify(metadata, null, 2));
        else stdout(`Export accepted: ${metadata.export_id}`);
        return { ...metadata, directory: '', files: [] };
    }

    while (!['ready', 'failed', 'expired'].includes(metadata.state)) {
        await (dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(metadata.retry_after_ms ?? 5_000);
        try {
            metadata = stableMetadata(await operation(config, { operation: 'export_status', name, export_id: metadata.export_id }));
        } catch (error) {
            teachingError(error);
        }
    }
    if (metadata.state === 'expired') throw new ExportCommandError('export_expired', 'This export has expired. Start a new export without --resume.', 410, metadata.export_id);
    if (metadata.state === 'failed') throw new ExportCommandError(metadata.error_code ?? 'export_failed', `${metadata.error_message ?? 'The export failed.'} Start a new export without --resume.`, undefined, metadata.export_id);
    if (!metadata.manifest_digest) {
        metadata = stableMetadata(await operation(config, { operation: 'export_status', name, export_id: metadata.export_id }));
    }
    if (!metadata.manifest_digest || !/^[0-9a-f]{64}$/.test(metadata.manifest_digest)) throw new ExportCommandError('upstream_unavailable', 'The ready export response was invalid.');

    let listing: ExportDownloads;
    try {
        listing = await operation<ExportDownloads>(config, { operation: 'export_downloads', name, export_id: metadata.export_id, ...(tables ? { tables } : {}) });
    } catch (error) {
        teachingError(error);
    }
    if (
        !listing || listing.export_id !== metadata.export_id || !listing.manifest
        || listing.manifest.filename !== 'manifest.json'
        || listing.manifest.digest !== metadata.manifest_digest
        || !safeDownloadUrl(listing.manifest.url) || !Array.isArray(listing.files)
    ) throw new ExportCommandError('upstream_unavailable', 'The export download response was invalid.');
    const filenames = new Set<string>(['manifest.json']);
    for (const file of listing.files) {
        if (
            typeof file.table !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(file.table)
            || file.filename !== `${file.table}.parquet`
            || !safeDownloadUrl(file.url) || !Number.isSafeInteger(file.bytes) || (file.bytes ?? -1) < 0
            || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)
            || filenames.has(file.filename)
        ) throw new ExportCommandError('upstream_unavailable', 'The export download response was invalid.');
        filenames.add(file.filename);
    }
    const wanted = [...listing.files, { ...listing.manifest, digest: metadata.manifest_digest }];
    const directory = options.output ? path.resolve(cwd, options.output) : defaultDirectory(cwd, database.name, metadata);
    await assertSafeDirectory(directory);
    if (!options.resume && !await directoryIsEmpty(directory)) throw new ExportCommandError('output_not_empty', `Export destination must be absent or empty: ${directory}`);
    await fs.promises.mkdir(directory, { recursive: true });
    await assertSafeDirectory(directory);
    if (options.resume) {
        for (const item of wanted) await fs.promises.rm(path.join(directory, `${item.filename}.part`), { force: true });
    }
    const completed: DatabaseExportResult['files'] = [];
    for (const item of wanted) {
        if (!/^[a-z][a-z0-9_]{0,62}\.parquet$/.test(item.filename) && item.filename !== 'manifest.json') throw new ExportCommandError('unsafe_filename', 'The export contained an unsafe filename.');
        const target = path.join(directory, item.filename);
        const expected = item.sha256 ?? item.digest;
        const existing = options.resume ? await hashFile(target) : null;
        if (existing && existing.bytes === (item.bytes ?? existing.bytes) && existing.sha256 === expected) {
            completed.push({ ...(item.table ? { table: item.table } : {}), filename: item.filename, path: target, ...existing });
            if (!options.json) stdout(`Verified ${item.filename} (${existing.bytes} bytes)`);
            continue;
        }
        if (existing) await fs.promises.rm(target);
        if (!options.json) stderr(`Downloading ${item.filename}…`);

        // Mint immediately before each object, never batch URLs ahead of a long download.
        try {
            listing = await operation<ExportDownloads>(config, { operation: 'export_downloads', name, export_id: metadata.export_id, ...(tables ? { tables } : {}) });
        } catch (error: any) {
            if (error?.code === 'export_expired') throw new ExportCommandError('export_superseded', 'This export expired or was superseded while downloading. Start a new export.', 409, metadata.export_id);
            throw error;
        }
        const fresh = refreshedDownload(listing, metadata.export_id, item);
        if (!fresh) throw new ExportCommandError('export_superseded', 'This export was superseded while downloading. Start a new export.', 409, metadata.export_id);
        try {
            const verified = await download(fresh, target);
            completed.push({ ...(item.table ? { table: item.table } : {}), filename: item.filename, path: target, ...verified });
            if (!options.json) stdout(`Downloaded ${item.filename} (${verified.bytes} bytes)`);
        } catch (error: any) {
            if (error?.status !== 403) throw new ExportCommandError(error.code ?? 'download_failed', `${error.message ?? 'Download failed.'} Completed files were kept. Rerun with --resume ${metadata.export_id}.`, error.status, metadata.export_id);
            try {
                const refreshed = await operation<ExportDownloads>(config, { operation: 'export_downloads', name, export_id: metadata.export_id, ...(tables ? { tables } : {}) });
                const retry = refreshedDownload(refreshed, metadata.export_id, item);
                if (!retry) throw new ExportCommandError('export_superseded', 'This export was superseded while downloading. Start a new export.', 409, metadata.export_id);
                const verified = await download(retry, target);
                completed.push({ ...(item.table ? { table: item.table } : {}), filename: item.filename, path: target, ...verified });
                if (!options.json) stdout(`Downloaded ${item.filename} (${verified.bytes} bytes)`);
            } catch (refreshError: any) {
                if (refreshError?.code === 'export_expired') throw new ExportCommandError('export_superseded', 'This export expired or was superseded while downloading. Start a new export.', 409, metadata.export_id);
                throw refreshError;
            }
        }
    }

    const result = { ...metadata, directory, files: completed };
    if (options.json) stdout(JSON.stringify(result, null, 2));
    else {
        stdout(`Export ready until ${metadata.expires_at ?? 'unknown'}.`);
        stdout(`Saved to ${directory}`);
    }
    return result;
}

export async function databaseExport(name: string, options: DatabaseExportOptions): Promise<void> {
    await databaseExportWithConfig(name, options, await requireConfigWithWorkspace());
}
