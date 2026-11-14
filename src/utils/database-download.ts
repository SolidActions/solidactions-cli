import axios from 'axios';
import { createHash } from 'crypto';
import { Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import zlib from 'zlib';
import { DatabaseOperationError } from './database-data-plane';

/** What the app says about the object behind a `pull_url` link. */
export interface DuckdbPullObject {
    url: string;
    /** Size of the database file once decompressed. */
    bytes: number;
    /** Size of the stored (zstd) object as downloaded. */
    stored_bytes: number;
    /** SHA-256 (hex) of the stored (zstd) object as downloaded. */
    sha256: string;
}

/** The link was refused (HTTP 403): it expired, so the caller asks for a fresh one. */
export class DuckdbLinkExpiredError extends Error {
    constructor() {
        super('The download link expired.');
        delete this.stack;
    }
}

// `@types/node` predates `zlib.createZstdDecompress` (Node 22.15 / 23.8), so the
// one place that touches it casts the missing declaration.
type ZstdZlib = { createZstdDecompress?: () => Transform };

/** True when this Node can decompress zstd without a dependency. */
export function zstdDecompressAvailable(): boolean {
    return typeof (zlib as unknown as ZstdZlib).createZstdDecompress === 'function';
}

function createZstdDecompress(): Transform {
    return (zlib as unknown as { createZstdDecompress: () => Transform }).createZstdDecompress();
}

function corrupt(): DatabaseOperationError {
    return new DatabaseOperationError(
        'download_corrupt',
        'The downloaded database did not match its recorded size and checksum. Nothing was saved.',
    );
}

/** Counts the bytes passing through and refuses to pass more than `limit`. */
function meter(limit: number, onChunk?: (chunk: Buffer) => void): { stream: Transform; count: () => number } {
    let count = 0;
    const stream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            count += chunk.length;
            if (count > limit) {
                callback(corrupt());
                return;
            }
            onChunk?.(chunk);
            callback(null, chunk);
        },
    });
    return { stream, count: () => count };
}

/**
 * Stream a DuckDB database file from its signed link into `sink`: the stored
 * (zstd) bytes are counted and hashed on the way in, decompressed, and the
 * decompressed bytes counted on the way out. Every figure must match what the
 * app recorded or the download is `download_corrupt`. The sink is left for the
 * caller to remove on failure; the link is never part of an error message.
 * `timeoutMs` bounds the wait for the response and any stall in the body (idle
 * time between chunks, not the whole download).
 */
export async function downloadDuckdbObject(object: DuckdbPullObject, sink: Writable, timeoutMs?: number): Promise<void> {
    let response;
    try {
        response = await axios.get(object.url, { responseType: 'stream', validateStatus: () => true, timeout: timeoutMs });
    } catch {
        throw new DatabaseOperationError('download_failed', 'The database download could not be started.');
    }
    if (response.status === 403) {
        response.data.destroy?.();
        throw new DuckdbLinkExpiredError();
    }
    if (response.status < 200 || response.status >= 300) {
        response.data.destroy?.();
        throw new DatabaseOperationError('download_failed', `The database download failed with HTTP ${response.status}.`);
    }

    const hash = createHash('sha256');
    const storedMeter = meter(object.stored_bytes, (chunk) => { hash.update(chunk); });
    const rawMeter = meter(object.bytes);
    const decompress = createZstdDecompress();
    // The first failure to surface is the cause: a decode error makes the
    // pipeline destroy the source, whose own error must not hide it.
    let firstFailure: 'transport' | 'decode' | undefined;
    response.data.on('error', () => { firstFailure ??= 'transport'; });
    decompress.on('error', () => { firstFailure ??= 'decode'; });

    // A server that sends headers and then goes quiet is a failed download.
    let idle: NodeJS.Timeout | undefined;
    const armIdleTimer = () => {
        if (timeoutMs === undefined) return;
        clearTimeout(idle);
        idle = setTimeout(() => { response.data.destroy(new Error('The database download stalled.')); }, timeoutMs);
    };
    response.data.on('data', armIdleTimer);
    armIdleTimer();

    try {
        await pipeline(response.data, storedMeter.stream, decompress, rawMeter.stream, sink);
    } catch (error) {
        if (error instanceof DatabaseOperationError) throw error;
        if (firstFailure === 'decode') throw corrupt();
        if (firstFailure === 'transport') {
            throw new DatabaseOperationError('download_failed', 'The database download was interrupted.');
        }
        throw error;
    } finally {
        clearTimeout(idle);
    }

    if (
        storedMeter.count() !== object.stored_bytes
        || rawMeter.count() !== object.bytes
        || hash.digest('hex') !== object.sha256
    ) {
        throw corrupt();
    }
}
