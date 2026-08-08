import { Buffer } from 'buffer';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

interface SqlGroup {
    sql: string;
    startByte: number;
    endByte: number;
    startLine: number;
    endLine: number;
}

interface ParsedImport {
    groups: SqlGroup[];
    foreignKeysOff: boolean;
}

async function requireParser(): Promise<(source: Buffer | string) => ParsedImport> {
    const url = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;
    const module = await import(url) as Record<string, unknown>;
    expect(module.parseDatabaseImportSql, 'parseDatabaseImportSql export').toBeTypeOf('function');
    return module.parseDatabaseImportSql as (source: Buffer | string) => ParsedImport;
}

function exactGroup(source: string, sql: string, startLine: number, endLine = startLine): SqlGroup {
    const characterStart = source.indexOf(sql);
    expect(characterStart, `fixture contains ${sql.slice(0, 30)}`).toBeGreaterThanOrEqual(0);
    return {
        sql,
        startByte: Buffer.byteLength(source.slice(0, characterStart), 'utf8'),
        endByte: Buffer.byteLength(source.slice(0, characterStart + sql.length), 'utf8'),
        startLine,
        endLine,
    };
}

function errorReport(error: unknown): string {
    const value = error as { code?: unknown; message?: unknown } | null;
    return `${String(value?.code ?? '')}\n${String(value?.message ?? '')}`;
}

describe('database SQL import parser', () => {
    it('reports original UTF-8 byte offsets and source lines for every complete group', async () => {
        const parse = await requireParser();
        const first = 'CREATE TABLE "café" (value TEXT);';
        const second = "INSERT INTO \"café\" VALUES ('snowman ☃; intact');";
        const source = `${first}\n\n${second}\n`;

        const parsed = parse(Buffer.from(source, 'utf8'));

        expect(parsed).toEqual({
            foreignKeysOff: false,
            groups: [
                exactGroup(source, first, 1),
                exactGroup(source, second, 3),
            ],
        });
    });

    it('does not split on semicolons in every supported quote and comment form', async () => {
        const parse = await requireParser();
        const statements = [
            "INSERT INTO t VALUES ('single; quote', 'doubled '' quote; stays');",
            'CREATE TABLE "double;identifier" ([bracket;identifier] TEXT, `backtick;identifier` TEXT);',
            '-- line comment; is not a boundary\nINSERT INTO t VALUES (1);',
            '/* block; comment\n   still comment; */\nINSERT INTO t VALUES (2);',
        ];
        const source = statements.join('\n');

        const parsed = parse(source);

        expect(parsed.groups.map((group) => group.sql)).toEqual(statements);
        expect(parsed.groups).toHaveLength(4);
    });

    it('keeps trigger BEGIN/END, internal semicolons, and nested CASE END expressions in one group', async () => {
        const parse = await requireParser();
        const before = 'CREATE TABLE audit (value TEXT);';
        const trigger = [
            'CREATE TRIGGER audit_insert AFTER INSERT ON audit BEGIN',
            "  INSERT INTO audit VALUES ('BEGIN; and END; in text');",
            '  SELECT CASE WHEN NEW.value IS NULL THEN',
            "    CASE WHEN 1 THEN 'inner;case' ELSE 'other' END",
            "  ELSE 'outer' END;",
            '  UPDATE audit SET value = value || ";quoted identifier literal";',
            'END;',
        ].join('\n');
        const after = "INSERT INTO audit VALUES ('after');";
        const source = `${before}\n${trigger}\n${after}\n`;

        const parsed = parse(source);

        expect(parsed.groups).toEqual([
            exactGroup(source, before, 1),
            exactGroup(source, trigger, 2, 8),
            exactGroup(source, after, 9),
        ]);
    });

    it('normalizes only the canonical sqlite dump envelope while preserving inner order and locations', async () => {
        const parse = await requireParser();
        const fixture = path.resolve(__dirname, 'fixtures/database-import/sqlite-dump.sql');
        const source = fs.readFileSync(fixture, 'utf8');
        const create = 'CREATE TABLE "audit;events" (id INTEGER PRIMARY KEY, value TEXT NOT NULL);';
        const insert = "INSERT INTO \"audit;events\" VALUES(1,'one;still one');";
        const trigger = [
            'CREATE TRIGGER audit_insert AFTER INSERT ON "audit;events" BEGIN',
            '  UPDATE "audit;events"',
            "  SET value = CASE WHEN NEW.value = 'raw;value' THEN 'normalized' ELSE NEW.value END",
            '  WHERE id = NEW.id;',
            'END;',
        ].join('\n');

        const parsed = parse(source);

        expect(parsed).toEqual({
            foreignKeysOff: true,
            groups: [
                exactGroup(source, create, 3),
                exactGroup(source, insert, 4),
                exactGroup(source, trigger, 5, 9),
            ],
        });
    });

    it.each([
        {
            label: 'minimal BEGIN spelling',
            source: 'BEGIN;\nCREATE TABLE t (id);\nCOMMIT;\n',
        },
        {
            label: 'no optional pragmas',
            source: 'BEGIN TRANSACTION;\nCREATE TABLE t (id);\nCOMMIT;\n',
        },
        {
            label: 'foreign key controls and comments',
            source: '-- sqlite dump\nPRAGMA foreign_keys = OFF;\nBEGIN;\nCREATE TABLE t (id);\nCOMMIT;\nPRAGMA foreign_keys = ON;\n',
        },
    ])('accepts canonical wrapper variant: $label', async ({ source }) => {
        const parse = await requireParser();

        const parsed = parse(source);

        expect(parsed.groups.map((group) => group.sql)).toEqual(['CREATE TABLE t (id);']);
    });

    it('accepts one leading UTF-8 BOM without polluting SQL while preserving its original byte offset', async () => {
        const parse = await requireParser();
        const sql = 'CREATE TABLE t (id);';
        const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sql)]);

        const parsed = parse(source);

        expect(parsed.groups).toEqual([{
            sql,
            startByte: 3,
            endByte: 3 + Buffer.byteLength(sql),
            startLine: 1,
            endLine: 1,
        }]);
    });

    it('accepts trailing whitespace and comments after the last complete statement', async () => {
        const parse = await requireParser();
        const sql = 'CREATE TABLE t (id);';

        const parsed = parse(`${sql}\n \t-- trailing line; comment\n/* trailing block; comment */\n`);

        expect(parsed.groups.map((group) => group.sql)).toEqual([sql]);
    });

    it.each([
        ['', 'empty input'],
        ['  \n-- only; a line comment\n/* only a block; comment */\n', 'comment-only input'],
    ])('parses $1 to zero groups for the command layer to reject', async (source) => {
        const parse = await requireParser();

        expect(parse(source)).toEqual({ foreignKeysOff: false, groups: [] });
    });

    it('refuses malformed UTF-8 instead of replacement-decoding it', async () => {
        const parse = await requireParser();
        const malformed = Buffer.concat([
            Buffer.from('CREATE TABLE t (value TEXT);\nINSERT INTO t VALUES (\''),
            Buffer.from([0xc3, 0x28]),
            Buffer.from("');"),
        ]);

        let caught: unknown;
        try {
            parse(malformed);
        } catch (error) {
            caught = error;
        }

        const report = errorReport(caught);
        expect(report).toMatch(/import_failed/i);
        expect(report).toMatch(/UTF-8|encoding/i);
    });

    it.each([
        ['OFF', 'PRAGMA foreign_keys=OFF;\nCREATE TABLE t (id);'],
        ['ON', 'CREATE TABLE t (id);\nPRAGMA foreign_keys=ON;'],
    ])('refuses standalone foreign_keys=%s outside a complete canonical envelope', async (mode, source) => {
        const parse = await requireParser();

        let caught: unknown;
        try {
            parse(source);
        } catch (error) {
            caught = error;
        }

        const report = errorReport(caught);
        expect(report).toMatch(/import_failed/i);
        expect(report).toMatch(/foreign_keys/i);
        expect(report).toMatch(mode === 'OFF' ? /line 1\b/i : /line 2\b/i);
    });

    it.each([
        ['BEGIN', 'CREATE TABLE t (id);\nBEGIN IMMEDIATE;\n'],
        ['END', 'CREATE TABLE t (id);\nEND;\n'],
        ['COMMIT', 'CREATE TABLE t (id);\nCOMMIT;\n'],
        ['ROLLBACK', 'CREATE TABLE t (id);\nROLLBACK;\n'],
        ['SAVEPOINT', 'CREATE TABLE t (id);\nSAVEPOINT import_step;\n'],
        ['RELEASE', 'CREATE TABLE t (id);\nRELEASE import_step;\n'],
    ])('refuses non-wrapper top-level %s with a stable source line', async (control, source) => {
        const parse = await requireParser();

        let caught: unknown;
        try {
            parse(source);
        } catch (error) {
            caught = error;
        }

        const report = errorReport(caught);
        expect(report).toMatch(/import_failed/i);
        expect(report).toContain(control);
        expect(report).toMatch(/line 2\b/i);
    });

    it.each([
        ['journal_mode', 'PRAGMA journal_mode=WAL;'],
        ['defer_foreign_keys', 'PRAGMA defer_foreign_keys=ON;'],
        ['foreign_keys', 'PRAGMA foreign_keys=ON;\nCREATE TABLE t (id);'],
        ['user_version', 'PRAGMA user_version=5;'],
    ])('refuses unsupported top-level PRAGMA %s by name and line', async (pragma, statement) => {
        const parse = await requireParser();
        const source = `-- header\n${statement}\n`;

        let caught: unknown;
        try {
            parse(source);
        } catch (error) {
            caught = error;
        }

        const report = errorReport(caught);
        expect(report).toMatch(/import_failed/i);
        expect(report).toContain(pragma);
        expect(report).toMatch(/line 2\b/i);
    });

    it.each([
        ['single quote', "INSERT INTO t VALUES ('unterminated);"],
        ['double quote', 'CREATE TABLE "unterminated (id);'],
        ['bracket identifier', 'CREATE TABLE [unterminated (id);'],
        ['backtick identifier', 'CREATE TABLE `unterminated (id);'],
        ['block comment', 'CREATE TABLE t (id); /* unterminated'],
        ['trigger', 'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1;'],
        ['ordinary statement', 'CREATE TABLE t (id)'],
        ['ambiguous END', 'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT CASE WHEN 1 THEN 2 END;'],
    ])('refuses incomplete or ambiguous input: $0', async (_label, source) => {
        const parse = await requireParser();

        expect(() => parse(source)).toThrow(/line|incomplete|unterminated|boundary|trigger/i);
    });

    it.each([
        "CREATE TABLE t (id);\n-- DOWNLOAD INCOMPLETE: service unavailable\n",
        "\ufeffCREATE TABLE t (id);\r\n-- DOWNLOAD INCOMPLETE: browser stream failed\r\n",
    ])('refuses a raw incomplete-download marker instead of treating it as a comment', async (source) => {
        const parse = await requireParser();

        let caught: unknown;
        try {
            parse(Buffer.from(source, 'utf8'));
        } catch (error) {
            caught = error;
        }

        const report = errorReport(caught);
        expect(report).toMatch(/import_failed/i);
        expect(report).toMatch(/download.*incomplete|incomplete.*download/i);
    });

    it('accepts an exact 8 MiB statement and refuses one byte more', async () => {
        const parse = await requireParser();
        const limit = 8 * 1024 * 1024;
        const prefix = "INSERT INTO payloads(value) VALUES ('";
        const suffix = "');";
        const atLimit = `${prefix}${'x'.repeat(limit - Buffer.byteLength(prefix + suffix))}${suffix}`;
        const overLimit = atLimit.replace("');", "x');");

        expect(Buffer.byteLength(atLimit)).toBe(limit);
        expect(parse(atLimit).groups).toHaveLength(1);
        expect(() => parse(overLimit)).toThrow(/8 MiB|statement.*large|import_failed/i);
    });
});
