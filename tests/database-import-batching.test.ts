import { describe, expect, it } from 'vitest';
import {
    DEFAULT_IMPORT_BATCH_TIMEOUT_MS,
    LOCK_BACKOFF_BASE_MS,
    LOCK_BACKOFF_MAX_MS,
    MAX_BATCH_BYTES,
    MAX_BATCH_GROUPS,
    MAX_IMPORT_TIMEOUT_MS,
    SCHEMA_CATALOG_SQL,
    VECTOR_MAX_BATCH_GROUPS,
    isLockError,
    lockBackoffMs,
    mergeSchemaFacts,
    nextBatch,
    parseImportTimeoutMs,
    replayVerdict,
    schemaFactsFromSql,
    sourceHasVectorColumns,
    tokenizeSql,
} from '../src/utils/database-import-batching';
import type { DatabaseSqlImportGroup } from '../src/utils/database-sql-import';
import {
    DatabaseOperationError,
    isDatabaseDeadlineElapsed,
    runDatabaseClientOperationWithDeadline,
} from '../src/utils/database-data-plane';

function group(sql: string): DatabaseSqlImportGroup {
    return { sql, startByte: 0, endByte: sql.length, startLine: 1, endLine: 1 };
}

function groupsOf(count: number, sql: string): DatabaseSqlImportGroup[] {
    return Array.from({ length: count }, () => group(sql));
}

describe('database import batching policy', () => {
    it('pins the frozen batching constants Tasks 2 and 3 consume', () => {
        expect(MAX_BATCH_GROUPS).toBe(100);
        expect(VECTOR_MAX_BATCH_GROUPS).toBe(20);
        expect(MAX_BATCH_BYTES).toBe(512 * 1024);
        expect(DEFAULT_IMPORT_BATCH_TIMEOUT_MS).toBe(300_000);
        expect(MAX_IMPORT_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
        expect(LOCK_BACKOFF_BASE_MS).toBe(1000);
        expect(LOCK_BACKOFF_MAX_MS).toBe(10_000);
        expect(SCHEMA_CATALOG_SQL).toBe(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index','trigger')",
        );
    });

    it('takes up to maxGroups one-byte groups from the start offset', () => {
        const all = groupsOf(250, 'x');

        const first = nextBatch(all, 0, 100);
        expect(first.groups).toHaveLength(100);
        expect(first.nextStatement).toBe(100);

        const second = nextBatch(all, 100, 20);
        expect(second.groups).toHaveLength(20);
        expect(second.nextStatement).toBe(120);
    });

    it('stops before the group that would cross the byte cap', () => {
        const big = 'x'.repeat(200_000);
        const all = groupsOf(3, big);

        const batch = nextBatch(all, 0, 100);
        expect(batch.groups).toHaveLength(2);
        expect(batch.nextStatement).toBe(2);
    });

    it('returns one over-cap group alone', () => {
        const over = 'x'.repeat(MAX_BATCH_BYTES + 1);
        const batch = nextBatch([group(over)], 0, 100);
        expect(batch.groups).toHaveLength(1);
        expect(batch.nextStatement).toBe(1);
    });

    it('tokenizes words, a quoted identifier and punctuation', () => {
        expect(tokenizeSql('INSERT OR REPLACE INTO "my table" (a)')).toEqual([
            { kind: 'word', text: 'INSERT' },
            { kind: 'word', text: 'OR' },
            { kind: 'word', text: 'REPLACE' },
            { kind: 'word', text: 'INTO' },
            { kind: 'ident', text: 'my table' },
            { kind: 'punct', text: '(' },
            { kind: 'word', text: 'a' },
            { kind: 'punct', text: ')' },
        ]);
    });

    it('skips line and block comments', () => {
        expect(tokenizeSql('-- x\n/* y */ SELECT')).toEqual([{ kind: 'word', text: 'SELECT' }]);
    });

    it("reads a doubled quote as one string token and brackets as one identifier", () => {
        expect(tokenizeSql("'it''s'")).toEqual([{ kind: 'string', text: "it's" }]);
        expect(tokenizeSql('[a b]')).toEqual([{ kind: 'ident', text: 'a b' }]);
    });

    it('ends a bracket identifier at the first closing bracket', () => {
        expect(tokenizeSql('[a]]')).toEqual([
            { kind: 'ident', text: 'a' },
            { kind: 'punct', text: ']' },
        ]);
    });

    it('ends the stream without throwing on an unterminated quote or comment', () => {
        expect(tokenizeSql("'abc")).toEqual([]);
        expect(tokenizeSql('/* abc')).toEqual([]);
        expect(tokenizeSql("SELECT 'abc")).toEqual([{ kind: 'word', text: 'SELECT' }]);
    });

    it('stops after maxTokens tokens', () => {
        expect(tokenizeSql('SELECT a, b', 3)).toEqual([
            { kind: 'word', text: 'SELECT' },
            { kind: 'word', text: 'a' },
            { kind: 'punct', text: ',' },
        ]);
    });

    it('keys a table by an inline PRIMARY KEY or a UNIQUE column definition', () => {
        expect(schemaFactsFromSql(['CREATE TABLE t (id INTEGER PRIMARY KEY, v);'], 'source').get('t')).toEqual({
            keyed: true,
            triggered: false,
        });
        expect(schemaFactsFromSql(['CREATE TABLE "T" (a, b, UNIQUE (a));'], 'source').get('t')).toEqual({
            keyed: true,
            triggered: false,
        });
        expect(schemaFactsFromSql(['CREATE TABLE t (a, b);'], 'source').get('t')).toEqual({
            keyed: false,
            triggered: false,
        });
    });

    it('never takes a keyed fact from a string, a quoted name or a comment', () => {
        expect(
            schemaFactsFromSql(["CREATE TABLE t (a TEXT DEFAULT 'primary key');"], 'source').get('t'),
        ).toEqual({ keyed: false, triggered: false });
        expect(schemaFactsFromSql(['CREATE TABLE t ("unique" TEXT);'], 'source').get('t')).toEqual({
            keyed: false,
            triggered: false,
        });
        expect(schemaFactsFromSql(['CREATE TABLE t ([primary key] TEXT);'], 'source').get('t')).toEqual({
            keyed: false,
            triggered: false,
        });
        expect(
            schemaFactsFromSql(['CREATE TABLE t (a, -- unique\n b /* primary key */);'], 'source').get('t'),
        ).toEqual({ keyed: false, triggered: false });
    });

    it('takes a unique index as a keyed fact but not a partial or plain index', () => {
        expect(schemaFactsFromSql(['CREATE UNIQUE INDEX i ON t(a);'], 'source').get('t')).toEqual({
            keyed: true,
            triggered: false,
        });
        expect(schemaFactsFromSql(['CREATE UNIQUE INDEX i ON t(a) WHERE a > 0;'], 'source').get('t'))
            .toBeUndefined();
        expect(schemaFactsFromSql(['CREATE INDEX i ON t(a);'], 'source').get('t')).toBeUndefined();
    });

    it('marks the trigger table through a qualified name, not a comment or a quoted name', () => {
        expect(
            schemaFactsFromSql(
                ['CREATE TRIGGER tr AFTER INSERT ON "main"."t" BEGIN SELECT 1; END;'],
                'source',
            ).get('t'),
        ).toEqual({ keyed: false, triggered: true });
        expect(
            schemaFactsFromSql(
                ['CREATE TRIGGER tr AFTER INSERT ON t /* ON other */ BEGIN SELECT 1; END;'],
                'source',
            ).get('t'),
        ).toEqual({ keyed: false, triggered: true });
        expect(
            schemaFactsFromSql(
                ['CREATE TRIGGER "on" AFTER INSERT ON t BEGIN SELECT 1; END;'],
                'source',
            ).get('t'),
        ).toEqual({ keyed: false, triggered: true });
    });

    it('keeps triggers across a re-CREATE TABLE but records no fact for a TEMP table', () => {
        const facts = schemaFactsFromSql(
            [
                'CREATE TABLE t (a);',
                'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END;',
                'CREATE TABLE t (a);',
            ],
            'source',
        );
        expect(facts.get('t')).toEqual({ keyed: false, triggered: true });
        expect(schemaFactsFromSql(['CREATE TEMP TABLE t (id PRIMARY KEY);'], 'source').get('t'))
            .toBeUndefined();
    });

    it('gives no keyed fact for a source IF NOT EXISTS table or unique index, but still marks its trigger', () => {
        const facts = schemaFactsFromSql(
            [
                'CREATE TABLE IF NOT EXISTS t (id PRIMARY KEY);',
                'CREATE UNIQUE INDEX IF NOT EXISTS i ON t(a);',
            ],
            'source',
        );
        expect(facts.get('t')).toBeUndefined();
        const triggered = schemaFactsFromSql(
            ['CREATE TRIGGER IF NOT EXISTS tr AFTER INSERT ON t BEGIN SELECT 1; END;'],
            'source',
        );
        expect(triggered.get('t')).toEqual({ keyed: false, triggered: true });
    });

    it('forgets a table, an index and a trigger at DROP and both sides of RENAME TO', () => {
        expect(
            schemaFactsFromSql(['CREATE TABLE t (id PRIMARY KEY);', 'DROP TABLE t;'], 'source').get('t'),
        ).toBeUndefined();
        expect(
            schemaFactsFromSql(
                ['CREATE TABLE t (id PRIMARY KEY);', 'DROP TABLE t;', 'CREATE TABLE t (a);'],
                'source',
            ).get('t'),
        ).toEqual({ keyed: false, triggered: false });
        expect(
            schemaFactsFromSql(
                ['CREATE TABLE t (a);', 'CREATE UNIQUE INDEX i ON t(a);', 'DROP INDEX i;'],
                'source',
            ).get('t'),
        ).toEqual({ keyed: false, triggered: false });
        expect(
            schemaFactsFromSql(
                [
                    'CREATE TABLE t (id PRIMARY KEY);',
                    'CREATE UNIQUE INDEX i ON t(a);',
                    'DROP INDEX i;',
                ],
                'source',
            ).get('t'),
        ).toEqual({ keyed: true, triggered: false });
        expect(
            schemaFactsFromSql(
                [
                    'CREATE TABLE t (a);',
                    'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END;',
                    'DROP TRIGGER tr;',
                ],
                'source',
            ).get('t'),
        ).toEqual({ keyed: false, triggered: false });
        const renamed = schemaFactsFromSql(
            [
                'CREATE TABLE t (id PRIMARY KEY);',
                'CREATE TABLE u (a);',
                'ALTER TABLE t RENAME TO u;',
            ],
            'source',
        );
        expect(renamed.get('t')).toBeUndefined();
        expect(renamed.get('u')).toBeUndefined();
    });

    it("takes catalog facts as written, including a table's IF NOT EXISTS", () => {
        expect(schemaFactsFromSql(['CREATE TABLE IF NOT EXISTS t (id PRIMARY KEY)'], 'catalog').get('t'))
            .toEqual({ keyed: true, triggered: false });
        const facts = schemaFactsFromSql(
            [
                'CREATE TABLE t (id PRIMARY KEY)',
                'CREATE UNIQUE INDEX i ON t(id)',
                'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END',
            ],
            'catalog',
        );
        expect(facts.get('t')).toEqual({ keyed: true, triggered: true });
    });

    it('merges facts with the override keyed winning and triggered OR-ed', () => {
        const merged = mergeSchemaFacts(
            new Map([
                ['t', { keyed: true, triggered: false }],
                ['base-only', { keyed: true, triggered: true }],
            ]),
            new Map([
                ['t', { keyed: false, triggered: true }],
                ['over-only', { keyed: true, triggered: false }],
            ]),
        );
        expect(merged.get('t')).toEqual({ keyed: false, triggered: true });
        expect(merged.get('base-only')).toEqual({ keyed: true, triggered: true });
        expect(merged.get('over-only')).toEqual({ keyed: true, triggered: false });
    });

    it('judges idempotent upserts and guarded creates as safe', () => {
        const facts = schemaFactsFromSql(['CREATE TABLE t (id INTEGER PRIMARY KEY);'], 'source');
        for (const sql of [
            'INSERT OR REPLACE INTO "t" VALUES (1);',
            'insert or ignore into t values (1);',
            'REPLACE INTO t VALUES (1);',
            '-- c\nINSERT OR REPLACE INTO t VALUES (1);',
            '/* c */ CREATE TABLE IF NOT EXISTS u (id);',
            'CREATE UNIQUE INDEX IF NOT EXISTS i ON t(id);',
        ]) {
            expect(replayVerdict([group(sql)], facts), sql).toEqual({ status: 'safe', unknownTables: [] });
        }
    });

    it('judges plain writes and unguarded schema changes as unsafe with the first group pinned', () => {
        const facts = schemaFactsFromSql(['CREATE TABLE t (id INTEGER PRIMARY KEY);'], 'source');
        for (const sql of [
            'INSERT INTO t VALUES (1);',
            'CREATE TABLE t (id);',
            'CREATE INDEX i ON t(id);',
            'UPDATE t SET a = 1;',
            'DELETE FROM t;',
            'DROP TABLE t;',
            "INSERT INTO t SELECT 1 WHERE 'INSERT OR REPLACE INTO' IS NOT NULL;",
        ]) {
            const first = group(sql);
            expect(replayVerdict([first], facts), sql).toEqual({
                status: 'unsafe',
                firstUnsafe: first,
                unknownTables: [],
            });
        }
    });

    it('judges a keyless or triggered table unsafe even for an upsert head', () => {
        const keyless = schemaFactsFromSql(['CREATE TABLE k (a);'], 'source');
        const keylessGroup = group('INSERT OR REPLACE INTO k VALUES (1);');
        expect(replayVerdict([keylessGroup], keyless)).toEqual({
            status: 'unsafe',
            firstUnsafe: keylessGroup,
            unknownTables: [],
        });
        const triggered = schemaFactsFromSql(
            [
                'CREATE TABLE t (id INTEGER PRIMARY KEY);',
                'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END;',
            ],
            'source',
        );
        const triggeredGroup = group('INSERT OR REPLACE INTO t VALUES (1);');
        expect(replayVerdict([triggeredGroup], triggered)).toEqual({
            status: 'unsafe',
            firstUnsafe: triggeredGroup,
            unknownTables: [],
        });
    });

    it('resolves table names through main qualifiers and quoted identifiers', () => {
        const facts = schemaFactsFromSql(['CREATE TABLE t (id INTEGER PRIMARY KEY);'], 'source');
        for (const sql of [
            'INSERT OR REPLACE INTO t(a) VALUES (1);',
            'INSERT OR REPLACE INTO main."t" VALUES (1);',
            'INSERT OR REPLACE INTO "main".t VALUES (1);',
        ]) {
            expect(replayVerdict([group(sql)], facts), sql).toEqual({ status: 'safe', unknownTables: [] });
        }
        const spaced = schemaFactsFromSql(['CREATE TABLE "my table" (id PRIMARY KEY);'], 'source');
        expect(replayVerdict([group('INSERT OR REPLACE INTO "my table" (a) VALUES (1);')], spaced)).toEqual({
            status: 'safe',
            unknownTables: [],
        });
    });

    it('reports temp-qualified tables as unknown while a string or comment cannot forge the head', () => {
        const facts = schemaFactsFromSql(['CREATE TABLE t (id INTEGER PRIMARY KEY);'], 'source');
        expect(replayVerdict([group('INSERT OR REPLACE INTO temp.t VALUES (1);')], facts)).toEqual({
            status: 'unknown',
            unknownTables: ['temp.t'],
        });
        const forgedString = group("INSERT INTO t VALUES ('OR REPLACE'); ");
        expect(replayVerdict([forgedString], facts)).toEqual({
            status: 'unsafe',
            firstUnsafe: forgedString,
            unknownTables: [],
        });
        const forgedComment = group('-- INSERT OR REPLACE INTO t\nDELETE FROM t;');
        expect(replayVerdict([forgedComment], facts)).toEqual({
            status: 'unsafe',
            firstUnsafe: forgedComment,
            unknownTables: [],
        });
    });

    it('reports an unknown table once, lets unsafe win over unknown, and unknown win over safe', () => {
        const empty = new Map();
        expect(replayVerdict([group('INSERT OR REPLACE INTO nope VALUES (1);')], empty)).toEqual({
            status: 'unknown',
            unknownTables: ['nope'],
        });
        const repeated = [
            group('INSERT OR REPLACE INTO nope VALUES (1);'),
            group('INSERT OR REPLACE INTO "NOPE" VALUES (2);'),
            group('INSERT OR REPLACE INTO nope VALUES (3);'),
        ];
        expect(replayVerdict(repeated, empty)).toEqual({ status: 'unknown', unknownTables: ['nope'] });
        const facts = schemaFactsFromSql(['CREATE TABLE t (id INTEGER PRIMARY KEY);'], 'source');
        const mixedUnsafe = [group('INSERT OR REPLACE INTO nope VALUES (1);'), group('DELETE FROM t;')];
        const unsafeVerdict = replayVerdict(mixedUnsafe, facts);
        expect(unsafeVerdict.status).toBe('unsafe');
        expect(unsafeVerdict.firstUnsafe).toBe(mixedUnsafe[1]);
        expect(replayVerdict(
            [group('INSERT OR REPLACE INTO nope VALUES (1);'), group('INSERT OR REPLACE INTO t VALUES (1);')],
            facts,
        )).toEqual({ status: 'unknown', unknownTables: ['nope'] });
    });

    it('detects vector columns and indexes behind the CREATE prefilter', () => {
        expect(sourceHasVectorColumns([group('CREATE TABLE docs (id INTEGER, embedding F32_BLOB(1536));')])).toBe(true);
        expect(
            sourceHasVectorColumns([group('CREATE INDEX docs_idx ON docs (libsql_vector_idx(embedding));')]),
        ).toBe(true);
        expect(sourceHasVectorColumns([group('CREATE TABLE v (e FLOAT32(4));')])).toBe(true);
        expect(sourceHasVectorColumns([group("INSERT INTO t VALUES ('F32_BLOB(3)');")])).toBe(false);
        expect(sourceHasVectorColumns([group('CREATE TABLE plain (id INTEGER, b BLOB);')])).toBe(false);
    });

    it('recognizes libsql lock errors by code prefix or lock message', () => {
        for (const error of [
            Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' }),
            Object.assign(new Error('snapshot'), { code: 'SQLITE_BUSY_SNAPSHOT' }),
            Object.assign(new Error('locked'), { code: 'SQLITE_LOCKED' }),
            new Error('database table is locked'),
            new Error('SERVER_ERROR: database is locked'),
        ]) {
            expect(isLockError(error), String((error as Error).message)).toBe(true);
        }
        expect(isLockError(new Error('x'))).toBe(false);
        expect(isLockError({ code: 'SQLITE_CONSTRAINT' })).toBe(false);
        expect(isLockError(null)).toBe(false);
        expect(isLockError('a string')).toBe(false);
    });

    it('backs lock retries off exponentially within the remaining budget', () => {
        expect(lockBackoffMs(0, 300000)).toBe(1000);
        expect(lockBackoffMs(1, 300000)).toBe(2000);
        expect(lockBackoffMs(3, 300000)).toBe(8000);
        expect(lockBackoffMs(4, 300000)).toBe(10000);
        expect(lockBackoffMs(9, 300000)).toBe(10000);
        expect(lockBackoffMs(0, 10)).toBe(10);
        expect(lockBackoffMs(2, 0)).toBe(0);
        expect(lockBackoffMs(2, -5)).toBe(0);
    });

    it('parses second, minute, hour and bare-second timeouts', () => {
        expect(parseImportTimeoutMs('30s')).toBe(30000);
        expect(parseImportTimeoutMs('15m')).toBe(900000);
        expect(parseImportTimeoutMs('1h')).toBe(3600000);
        expect(parseImportTimeoutMs('90')).toBe(90000);
        expect(parseImportTimeoutMs(' 2m ')).toBe(120000);
        expect(parseImportTimeoutMs('24h')).toBe(86400000);
    });

    it('rejects unshaped timeout values with an invalid_timeout error', () => {
        for (const value of ['', '0', '0s', 'abc', '1.5', '-3', '25h', '10x']) {
            let error: unknown;
            try {
                parseImportTimeoutMs(value);
            } catch (caught) {
                error = caught;
            }
            expect(error, value).toBeInstanceOf(DatabaseOperationError);
            expect((error as DatabaseOperationError).code, value).toBe('invalid_timeout');
        }
        let message: unknown;
        try {
            parseImportTimeoutMs('abc');
        } catch (caught) {
            message = (caught as Error).message;
        }
        expect(message).toBe('--timeout must look like 30s, 15m or 1h (1 second to 24 hours), got "abc".');
    });

    it('detects only a real deadline expiry, not a hand-built timeout error', async () => {
        const rejection = await runDatabaseClientOperationWithDeadline(
            () => new Promise<never>(() => undefined),
            undefined,
            5,
        ).then(
            () => null,
            (error: unknown) => error,
        );
        expect(isDatabaseDeadlineElapsed(rejection)).toBe(true);
        expect(isDatabaseDeadlineElapsed(new Error('x'))).toBe(false);
        expect(
            isDatabaseDeadlineElapsed(
                new DatabaseOperationError('upstream_unavailable', 'Database operation timed out.'),
            ),
        ).toBe(false);
    });
});
