import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
    canonicalIngestDigest,
    defaultIngestBatchId,
    ingestFormatFromExtension,
} from '../src/utils/database-ingest-digest';

// Vectors below are cross-checked against a standalone port of the real
// server implementation
// (App\Domains\Databases\Analytical\Support\CanonicalBatchDigest), run
// directly with `php` (no Laravel bootstrap needed — the class has no
// framework dependency beyond `Illuminate\Support\Str::lower`, which was
// replicated with `mb_strtolower($value, 'UTF-8')`, its actual
// implementation). Every digest asserted here was produced by that PHP
// script, not hand-computed.
describe('canonical ingest digest (spec §6.4, RFC 8785 restricted to this fixed shape)', () => {
    it('matches a hand-computed vector for a parquet identity', () => {
        const identity = {
            databaseId: '11111111-1111-1111-1111-111111111111',
            table: 'orders',
            mode: 'append' as const,
            format: 'parquet' as const,
            contentSha256: 'a'.repeat(64),
        };

        expect(canonicalIngestDigest(identity)).toBe(
            '26dd9a695355a7112f7fbc6c50115e42a5617eedff7bafad6e459e6dc73addea',
        );
        expect(defaultIngestBatchId(identity)).toBe('26dd9a695355a7112f7fbc6c50115e42');
    });

    it('matches a hand-computed vector for a csv identity', () => {
        const identity = {
            databaseId: '11111111-1111-1111-1111-111111111111',
            table: 'events',
            mode: 'append' as const,
            format: 'csv' as const,
            contentSha256: 'e4ae373336c660c0fd28bbb4ebb5c97fcb5d10258e82620c76562890a2105945',
        };

        expect(canonicalIngestDigest(identity)).toBe(
            'ba2245e691043668f70b69e6217e9bfbdbfd373affcc024f3b8f56c87b299722',
        );
        expect(defaultIngestBatchId(identity)).toBe('ba2245e691043668f70b69e6217e9bfb');
    });

    it('serialises v as the JSON integer 1, not the string "1"', () => {
        // If the implementation emitted `"v":"1"` instead of `"v":1`, this
        // independently-hashed canonical string would no longer match
        // canonicalIngestDigest's output — this test fails loudly on that
        // regression rather than relying only on the opaque hex vectors above.
        const identity = {
            databaseId: '11111111-1111-1111-1111-111111111111',
            table: 'orders',
            mode: 'append' as const,
            format: 'parquet' as const,
            contentSha256: 'a'.repeat(64),
        };
        const expectedCanonicalJson = '{"ack":"durable","content_sha256":"'
            + 'a'.repeat(64)
            + '","database_id":"11111111-1111-1111-1111-111111111111","format":"parquet","mode":"append","table":"orders","v":1}';
        const expectedDigest = createHash('sha256').update(expectedCanonicalJson, 'utf8').digest('hex');

        expect(expectedDigest).toBe('26dd9a695355a7112f7fbc6c50115e42a5617eedff7bafad6e459e6dc73addea');
        expect(canonicalIngestDigest(identity)).toBe(expectedDigest);
    });

    it('gives replace a different digest than append for the same file', () => {
        const base = {
            databaseId: '11111111-1111-1111-1111-111111111111',
            table: 'orders',
            format: 'parquet' as const,
            contentSha256: 'b'.repeat(64),
        };

        expect(canonicalIngestDigest({ ...base, mode: 'append' }))
            .not.toBe(canonicalIngestDigest({ ...base, mode: 'replace' }));
    });

    it('normalizes a mixed-case, whitespace-padded table name to the same digest as its trimmed lower-case form', () => {
        const padded = canonicalIngestDigest({
            databaseId: '11111111-1111-1111-1111-111111111111',
            table: '  Orders  ',
            mode: 'append',
            format: 'parquet',
            contentSha256: 'a'.repeat(64),
        });
        const normalized = canonicalIngestDigest({
            databaseId: '11111111-1111-1111-1111-111111111111',
            table: 'orders',
            mode: 'append',
            format: 'parquet',
            contentSha256: 'a'.repeat(64),
        });

        expect(padded).toBe(normalized);
        expect(padded).toBe('26dd9a695355a7112f7fbc6c50115e42a5617eedff7bafad6e459e6dc73addea');
    });

    it('normalizes an upper-case content hash to the same digest as its lower-case form', () => {
        const upper = canonicalIngestDigest({
            databaseId: '11111111-1111-1111-1111-111111111111',
            table: 'orders',
            mode: 'append',
            format: 'parquet',
            contentSha256: 'A'.repeat(64),
        });
        const lower = canonicalIngestDigest({
            databaseId: '11111111-1111-1111-1111-111111111111',
            table: 'orders',
            mode: 'append',
            format: 'parquet',
            contentSha256: 'a'.repeat(64),
        });

        expect(upper).toBe(lower);
        expect(upper).toBe('26dd9a695355a7112f7fbc6c50115e42a5617eedff7bafad6e459e6dc73addea');
    });

    it('matches the PHP-derived vector for a non-ASCII, upper-case, whitespace-padded table name', () => {
        const identity = {
            databaseId: '11111111-1111-1111-1111-111111111111',
            table: '  ÉVÉNEMENTS  ',
            mode: 'append' as const,
            format: 'jsonl' as const,
            contentSha256: 'c'.repeat(64),
        };

        expect(canonicalIngestDigest(identity)).toBe(
            '04c4fdde50fc2c5241122c84c11e01355de41a3ba1e87443837027ecd7912939',
        );
        expect(defaultIngestBatchId(identity)).toBe('04c4fdde50fc2c5241122c84c11e0135');
    });

    it('maps extensions to formats and rejects unknown ones', () => {
        expect(ingestFormatFromExtension('data.parquet')).toBe('parquet');
        expect(ingestFormatFromExtension('data.csv')).toBe('csv');
        expect(ingestFormatFromExtension('data.jsonl')).toBe('jsonl');
        expect(() => ingestFormatFromExtension('data.txt')).toThrow(/Unsupported ingest file extension/);
    });
});
