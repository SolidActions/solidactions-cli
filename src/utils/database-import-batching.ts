import { DatabaseOperationError } from './database-data-plane';
import type { DatabaseSqlImportGroup } from './database-sql-import';

export const MAX_BATCH_GROUPS = 100;
export const VECTOR_MAX_BATCH_GROUPS = 20;
export const MAX_BATCH_BYTES = 512 * 1024;
export const DEFAULT_IMPORT_BATCH_TIMEOUT_MS = 300_000;
export const MAX_IMPORT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const LOCK_BACKOFF_BASE_MS = 1000;
export const LOCK_BACKOFF_MAX_MS = 10_000;
/** The one catalog query the runner sends (D8). Rows are [type, name, tbl_name, sql]. */
export const SCHEMA_CATALOG_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index','trigger')";

export interface ImportBatch {
    groups: DatabaseSqlImportGroup[];
    nextStatement: number;
}

/** What is known about one table: it has a PRIMARY KEY or UNIQUE constraint / non-partial unique index, and whether any trigger is on it. */
export interface TableFacts { keyed: boolean; triggered: boolean }
/** Key: the table name lower-cased and unquoted (a `main.` prefix dropped). */
export type SchemaFacts = Map<string, TableFacts>;

/** Why a known table makes a statement unsafe to repeat. */
export interface UnsafeTable { name: string; reason: 'no-key' | 'trigger' }

export interface ReplayVerdict {
    /** safe: every statement is safe to repeat. unsafe: at least one is definitely not. unknown: none is definitely unsafe, but a table's keys are not known. */
    status: 'safe' | 'unsafe' | 'unknown';
    /** The first statement that is definitely not safe (status unsafe). */
    firstUnsafe?: DatabaseSqlImportGroup;
    /** Set only when firstUnsafe is an upsert into a table the facts know: the table as written in the statement and why it is unsafe ('trigger' wins over 'no-key' when both hold). */
    unsafeTable?: UnsafeTable;
    /** Names (as written in the source) of the tables whose keys are not known (status unknown). */
    unknownTables: string[];
}

/** The same batching rule the runner used (group cap and byte cap), with the group cap as a parameter. */
export function nextBatch(groups: DatabaseSqlImportGroup[], start: number, maxGroups: number): ImportBatch {
    const selected: DatabaseSqlImportGroup[] = [];
    let bytes = 0;
    let index = start;
    while (index < groups.length && selected.length < maxGroups) {
        const groupBytes = Buffer.byteLength(groups[index].sql, 'utf8');
        if (selected.length > 0 && bytes + groupBytes > MAX_BATCH_BYTES) break;
        selected.push(groups[index]);
        bytes += groupBytes;
        index += 1;
        if (groupBytes > MAX_BATCH_BYTES) break;
    }
    return { groups: selected, nextStatement: index };
}

/** True when any CREATE statement group of the source declares a vector column or index. */
export function sourceHasVectorColumns(groups: DatabaseSqlImportGroup[]): boolean {
    for (const group of groups) {
        if (!/\bCREATE\b/i.test(group.sql.slice(0, 200))) continue;
        if (/\bF(?:32|64|16|8|1BIT)_BLOB\s*\(|\bFLOAT(?:32|64)\s*\(|libsql_vector_idx/i.test(group.sql)) return true;
    }
    return false;
}

/** One lexical token of an SQL statement. Comments are skipped. `word` is a bare keyword or identifier (text as written); `ident` is a quoted identifier ("x", `x`, [x]) with the quotes removed; `string` is a '...' literal (quotes removed); `punct` is any other single character. */
export interface SqlToken { kind: 'word' | 'ident' | 'string' | 'punct'; text: string }

function isWordStart(character: string): boolean {
    return character === '_' || (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z');
}

function isWordPart(character: string): boolean {
    return isWordStart(character) || (character >= '0' && character <= '9') || character === '$';
}

/** Tokenize `sql`, stopping after `maxTokens` tokens (default: all). Pure, never throws (an unterminated quote or comment ends the token stream). */
export function tokenizeSql(sql: string, maxTokens?: number): SqlToken[] {
    const tokens: SqlToken[] = [];
    const limit = maxTokens ?? Number.POSITIVE_INFINITY;
    let index = 0;
    while (index < sql.length && tokens.length < limit) {
        const character = sql[index];
        if (character === ' ' || character === '\t' || character === '\n' || character === '\r'
            || character === '\f' || character === '\v') {
            index += 1;
            continue;
        }
        if (character === '-' && sql[index + 1] === '-') {
            index += 2;
            while (index < sql.length && sql[index] !== '\n') index += 1;
            continue;
        }
        if (character === '/' && sql[index + 1] === '*') {
            const end = sql.indexOf('*/', index + 2);
            if (end === -1) return tokens;
            index = end + 2;
            continue;
        }
        if (character === "'") {
            const text = readDoubled(sql, index + 1, "'", "'");
            if (text === null) return tokens;
            tokens.push({ kind: 'string', text: text.value });
            index = text.next;
            continue;
        }
        if (character === '"' || character === '`') {
            const text = readDoubled(sql, index + 1, character, character);
            if (text === null) return tokens;
            tokens.push({ kind: 'ident', text: text.value });
            index = text.next;
            continue;
        }
        if (character === '[') {
            // SQLite ends a bracket identifier at the FIRST `]` (no doubling).
            const end = sql.indexOf(']', index + 1);
            if (end === -1) return tokens;
            tokens.push({ kind: 'ident', text: sql.slice(index + 1, end) });
            index = end + 1;
            continue;
        }
        if (isWordStart(character)) {
            let end = index + 1;
            while (end < sql.length && isWordPart(sql[end])) end += 1;
            tokens.push({ kind: 'word', text: sql.slice(index, end) });
            index = end;
            continue;
        }
        tokens.push({ kind: 'punct', text: character });
        index += 1;
    }
    return tokens;
}

function readDoubled(sql: string, index: number, closing: string, escaped: string): { value: string; next: number } | null {
    let value = '';
    let cursor = index;
    while (cursor < sql.length) {
        if (sql[cursor] === closing) {
            if (sql[cursor + 1] === closing) {
                value += escaped;
                cursor += 2;
                continue;
            }
            return { value, next: cursor + 1 };
        }
        value += sql[cursor];
        cursor += 1;
    }
    return null;
}

interface QualifiedName {
    key: string;
    raw: string;
    next: number;
}

function namePartText(tokens: SqlToken[], index: number): string | null {
    const token = tokens[index];
    if (token === undefined) return null;
    if (token.kind === 'word' || token.kind === 'ident' || token.kind === 'string') return token.text;
    return null;
}

/** Read `part[.part]` at `index`. The key is lower-cased; a `main.` first part is dropped. */
function qualifiedName(tokens: SqlToken[], index: number): QualifiedName | null {
    const first = namePartText(tokens, index);
    if (first === null) return null;
    const dot = tokens[index + 1];
    const second = dot !== undefined && dot.kind === 'punct' && dot.text === '.'
        ? namePartText(tokens, index + 2)
        : null;
    if (second !== null) {
        if (first.toLowerCase() === 'main') {
            return { key: second.toLowerCase(), raw: `${first}.${second}`, next: index + 3 };
        }
        return { key: `${first.toLowerCase()}.${second.toLowerCase()}`, raw: `${first}.${second}`, next: index + 3 };
    }
    return { key: first.toLowerCase(), raw: first, next: index + 1 };
}

function wordAt(tokens: SqlToken[], index: number): string | null {
    const token = tokens[index];
    if (token === undefined || token.kind !== 'word') return null;
    return token.text.toUpperCase();
}

function hasPrimaryKey(tokens: SqlToken[]): boolean {
    for (let index = 0; index + 1 < tokens.length; index += 1) {
        if (wordAt(tokens, index) === 'PRIMARY' && wordAt(tokens, index + 1) === 'KEY') return true;
    }
    return false;
}

function hasWord(tokens: SqlToken[], word: string): boolean {
    return tokens.some((token) => token.kind === 'word' && token.text.toUpperCase() === word);
}

function skipIfNotExists(tokens: SqlToken[], index: number): { index: number; ifNotExists: boolean } {
    if (wordAt(tokens, index) === 'IF' && wordAt(tokens, index + 1) === 'NOT' && wordAt(tokens, index + 2) === 'EXISTS') {
        return { index: index + 3, ifNotExists: true };
    }
    return { index, ifNotExists: false };
}

interface TableEntry {
    tableKeyed: boolean;
    uniqueIndexes: Set<string>;
    triggers: Set<string>;
}

function walkCreateTable(
    tokens: SqlToken[],
    objectIndex: number,
    origin: 'source' | 'catalog',
    entries: Map<string, TableEntry>,
): void {
    const skip = skipIfNotExists(tokens, objectIndex + 1);
    const name = qualifiedName(tokens, skip.index);
    if (name === null) return;
    if (skip.ifNotExists && origin === 'source') return;
    let entry = entries.get(name.key);
    if (entry === undefined) {
        entry = { tableKeyed: false, uniqueIndexes: new Set(), triggers: new Set() };
        entries.set(name.key, entry);
    }
    entry.tableKeyed = hasWord(tokens, 'UNIQUE') || hasPrimaryKey(tokens);
    entry.uniqueIndexes.clear();
}

function walkCreateIndex(
    tokens: SqlToken[],
    objectIndex: number,
    unique: boolean,
    origin: 'source' | 'catalog',
    entries: Map<string, TableEntry>,
): void {
    if (!unique) return;
    const skip = skipIfNotExists(tokens, objectIndex + 1);
    const indexName = qualifiedName(tokens, skip.index);
    if (indexName === null) return;
    if (skip.ifNotExists && origin === 'source') return;
    if (wordAt(tokens, indexName.next) !== 'ON') return;
    const table = qualifiedName(tokens, indexName.next + 1);
    if (table === null) return;
    if (hasWord(tokens, 'WHERE')) return;
    let entry = entries.get(table.key);
    if (entry === undefined) {
        entry = { tableKeyed: false, uniqueIndexes: new Set(), triggers: new Set() };
        entries.set(table.key, entry);
    }
    entry.uniqueIndexes.add(indexName.key);
}

function walkCreateTrigger(
    tokens: SqlToken[],
    triggerIndex: number,
    entries: Map<string, TableEntry>,
): void {
    const skip = skipIfNotExists(tokens, triggerIndex + 1);
    const name = qualifiedName(tokens, skip.index);
    if (name === null) return;
    for (let index = name.next; index < tokens.length; index += 1) {
        if (wordAt(tokens, index) === 'ON') {
            const table = qualifiedName(tokens, index + 1);
            if (table !== null) {
                let entry = entries.get(table.key);
                if (entry === undefined) {
                    entry = { tableKeyed: false, uniqueIndexes: new Set(), triggers: new Set() };
                    entries.set(table.key, entry);
                }
                entry.triggers.add(name.key);
            }
            return;
        }
    }
}

function walkCreate(
    tokens: SqlToken[],
    origin: 'source' | 'catalog',
    entries: Map<string, TableEntry>,
): void {
    if (wordAt(tokens, 1) === 'TEMP' || wordAt(tokens, 1) === 'TEMPORARY') {
        if (wordAt(tokens, 2) === 'TRIGGER') walkCreateTrigger(tokens, 2, entries);
        return;
    }
    if (wordAt(tokens, 1) === 'TRIGGER') {
        walkCreateTrigger(tokens, 1, entries);
        return;
    }
    let index = 1;
    let unique = false;
    while (wordAt(tokens, index) === 'UNIQUE' || wordAt(tokens, index) === 'VIRTUAL') {
        if (wordAt(tokens, index) === 'UNIQUE') unique = true;
        index += 1;
    }
    const object = wordAt(tokens, index);
    if (object === 'TABLE') {
        walkCreateTable(tokens, index, origin, entries);
    } else if (object === 'INDEX') {
        walkCreateIndex(tokens, index, unique, origin, entries);
    }
}

function walkDrop(tokens: SqlToken[], entries: Map<string, TableEntry>): void {
    const object = wordAt(tokens, 1);
    if (object !== 'TABLE' && object !== 'INDEX' && object !== 'TRIGGER') return;
    let index = 2;
    if (wordAt(tokens, index) === 'IF' && wordAt(tokens, index + 1) === 'EXISTS') index += 2;
    const name = qualifiedName(tokens, index);
    if (name === null) return;
    if (object === 'TABLE') {
        entries.delete(name.key);
        return;
    }
    for (const entry of entries.values()) {
        if (object === 'INDEX') entry.uniqueIndexes.delete(name.key);
        else entry.triggers.delete(name.key);
    }
}

function walkAlter(tokens: SqlToken[], entries: Map<string, TableEntry>): void {
    if (wordAt(tokens, 1) !== 'TABLE') return;
    const from = qualifiedName(tokens, 2);
    if (from === null) return;
    if (wordAt(tokens, from.next) !== 'RENAME' || wordAt(tokens, from.next + 1) !== 'TO') return;
    const to = qualifiedName(tokens, from.next + 2);
    if (to === null) return;
    entries.delete(from.key);
    entries.delete(to.key);
}

/**
 * Facts from CREATE TABLE / CREATE [UNIQUE] INDEX / CREATE TRIGGER statements, walked in order (source groups' `sql`, or the catalog's `sql` column),
 * forgetting a name at DROP TABLE / DROP INDEX / DROP TRIGGER / ALTER TABLE ... RENAME TO. Other statements are ignored.
 * origin 'source': a CREATE TABLE IF NOT EXISTS and a CREATE UNIQUE INDEX IF NOT EXISTS give no keyed fact (PM ruling 7).
 * origin 'catalog': facts are taken as written.
 */
export function schemaFactsFromSql(statements: Iterable<string>, origin: 'source' | 'catalog'): SchemaFacts {
    const entries = new Map<string, TableEntry>();
    for (const sql of statements) {
        const head = wordAt(tokenizeSql(sql, 3), 0);
        if (head !== 'CREATE' && head !== 'DROP' && head !== 'ALTER') continue;
        const tokens = tokenizeSql(sql);
        if (head === 'CREATE') walkCreate(tokens, origin, entries);
        else if (head === 'DROP') walkDrop(tokens, entries);
        else walkAlter(tokens, entries);
    }
    const facts: SchemaFacts = new Map();
    for (const [key, entry] of entries) {
        facts.set(key, {
            keyed: entry.tableKeyed || entry.uniqueIndexes.size > 0,
            triggered: entry.triggers.size > 0,
        });
    }
    return facts;
}

/** `override`'s tables replace `base`'s; a table is `triggered` when either side says so. Returns a new map. */
export function mergeSchemaFacts(base: SchemaFacts, override: SchemaFacts): SchemaFacts {
    const merged: SchemaFacts = new Map();
    for (const [key, facts] of base) merged.set(key, { keyed: facts.keyed, triggered: facts.triggered });
    for (const [key, facts] of override) {
        const existing = merged.get(key);
        merged.set(key, {
            keyed: facts.keyed,
            triggered: existing !== undefined ? existing.triggered || facts.triggered : facts.triggered,
        });
    }
    return merged;
}

type GroupSafety =
    | { status: 'safe' }
    | { status: 'unsafe'; table?: string; reason?: 'no-key' | 'trigger' }
    | { status: 'unknown'; key: string; table: string };

function upsertTarget(tokens: SqlToken[], index: number, facts: SchemaFacts): GroupSafety {
    const name = qualifiedName(tokens, index);
    if (name === null) return { status: 'unsafe' };
    const found = facts.get(name.key);
    if (found === undefined) return { status: 'unknown', key: name.key, table: name.raw };
    if (found.keyed && !found.triggered) return { status: 'safe' };
    return { status: 'unsafe', table: name.raw, reason: found.triggered ? 'trigger' : 'no-key' };
}

function groupSafety(tokens: SqlToken[], facts: SchemaFacts): GroupSafety {
    const head = wordAt(tokens, 0);
    if (head === 'CREATE') {
        let index = 1;
        while (true) {
            const modifier = wordAt(tokens, index);
            if (modifier === 'UNIQUE' || modifier === 'TEMP' || modifier === 'TEMPORARY' || modifier === 'VIRTUAL') {
                index += 1;
                continue;
            }
            break;
        }
        const object = wordAt(tokens, index);
        if (object === 'TABLE' || object === 'INDEX' || object === 'VIEW' || object === 'TRIGGER') {
            if (wordAt(tokens, index + 1) === 'IF'
                && wordAt(tokens, index + 2) === 'NOT'
                && wordAt(tokens, index + 3) === 'EXISTS') {
                return { status: 'safe' };
            }
        }
        return { status: 'unsafe' };
    }
    if (head === 'INSERT') {
        if (wordAt(tokens, 1) === 'OR'
            && (wordAt(tokens, 2) === 'REPLACE' || wordAt(tokens, 2) === 'IGNORE')
            && wordAt(tokens, 3) === 'INTO') {
            return upsertTarget(tokens, 4, facts);
        }
        return { status: 'unsafe' };
    }
    if (head === 'REPLACE') {
        if (wordAt(tokens, 1) === 'INTO') return upsertTarget(tokens, 2, facts);
        return { status: 'unsafe' };
    }
    return { status: 'unsafe' };
}

/** Judge whether the whole batch can be run twice with the same final state (D1). */
export function replayVerdict(groups: DatabaseSqlImportGroup[], facts: SchemaFacts): ReplayVerdict {
    let firstUnsafe: DatabaseSqlImportGroup | undefined;
    let unsafeTable: UnsafeTable | undefined;
    let hasUnknown = false;
    const unknownTables: string[] = [];
    const seenUnknownKeys = new Set<string>();
    for (const group of groups) {
        const safety = groupSafety(tokenizeSql(group.sql, 16), facts);
        if (safety.status === 'unsafe') {
            if (firstUnsafe === undefined) {
                firstUnsafe = group;
                if (safety.table !== undefined && safety.reason !== undefined) {
                    unsafeTable = { name: safety.table, reason: safety.reason };
                }
            }
        } else if (safety.status === 'unknown') {
            hasUnknown = true;
            if (!seenUnknownKeys.has(safety.key)) {
                seenUnknownKeys.add(safety.key);
                unknownTables.push(safety.table);
            }
        }
    }
    if (firstUnsafe !== undefined) {
        return unsafeTable === undefined
            ? { status: 'unsafe', firstUnsafe, unknownTables: [] }
            : { status: 'unsafe', firstUnsafe, unsafeTable, unknownTables: [] };
    }
    if (hasUnknown) return { status: 'unknown', unknownTables };
    return { status: 'safe', unknownTables: [] };
}

/**
 * The facts the batch's own CREATE TABLE IF NOT EXISTS statements will give a table the target does not have yet.
 * Walks `groups` in order with the 'catalog' origin (statements taken as written), then returns only the tables that
 * (a) the batch itself creates, exactly once, with CREATE TABLE IF NOT EXISTS (a name created, dropped or renamed more than once in the batch is not returned) and (b) are NOT keys of `catalogFacts`.
 * A table in `catalogFacts` is never returned (the target's shape wins). An index or trigger on a table the batch does not create gives nothing.
 * `catalogObjectNames` is every `name` (second column) of the catalog read, lower-cased: a batch CREATE UNIQUE INDEX IF NOT EXISTS whose name is in it is a no-op on the replay, so it is left out of the walk. The same holds inside the batch itself: SQLite treats a second CREATE [UNIQUE] INDEX IF NOT EXISTS of an already-taken index name as a silent no-op (it keeps the first index, even a plain non-unique one), so index names seen earlier in the batch occupy the name for the statements after them.
 */
export function batchCreatedFacts(
    groups: DatabaseSqlImportGroup[],
    catalogFacts: SchemaFacts,
    catalogObjectNames: ReadonlySet<string>,
): SchemaFacts {
    const walked = withoutNoopUniqueIndexes(groups, catalogObjectNames);
    const created = collectCreatedTableKeys(groups);
    const walkedFacts = schemaFactsFromSql(walked.map((g) => g.sql), 'catalog');
    const result: SchemaFacts = new Map();
    for (const [key, facts] of walkedFacts) {
        if (created.has(key) && !catalogFacts.has(key)) {
            result.set(key, { keyed: facts.keyed, triggered: facts.triggered });
        }
    }
    return result;
}

/** The index name a CREATE [UNIQUE] INDEX [IF NOT EXISTS] statement occupies, or null when `sql` is not one. TEMP indexes live in the temp schema, so they never occupy a persistent name. */
function createIndexName(sql: string): { key: string; unique: boolean; ifNotExists: boolean } | null {
    const tokens = tokenizeSql(sql);
    if (wordAt(tokens, 0) !== 'CREATE') return null;
    if (wordAt(tokens, 1) === 'TEMP' || wordAt(tokens, 1) === 'TEMPORARY') return null;
    let index = 1;
    let unique = false;
    while (wordAt(tokens, index) === 'UNIQUE' || wordAt(tokens, index) === 'VIRTUAL') {
        if (wordAt(tokens, index) === 'UNIQUE') unique = true;
        index += 1;
    }
    if (wordAt(tokens, index) !== 'INDEX') return null;
    const skip = skipIfNotExists(tokens, index + 1);
    const name = qualifiedName(tokens, skip.index);
    if (name === null) return null;
    return { key: name.key, unique, ifNotExists: skip.ifNotExists };
}

/**
 * `groups` without a CREATE UNIQUE INDEX IF NOT EXISTS whose index name is already taken: by the target catalog
 * (`catalogObjectNames`, lower-cased), or by an earlier CREATE [UNIQUE] INDEX [IF NOT EXISTS] in the batch itself.
 * SQLite replays such a guarded repeat as a silent no-op, so the walk must not count it as a key. Every CREATE INDEX
 * name seen (plain or unique, guarded or not, schema-qualified or quoted: the key folds case and drops `main.`)
 * occupies the name for the statements after it.
 */
function withoutNoopUniqueIndexes(
    groups: DatabaseSqlImportGroup[],
    catalogObjectNames: ReadonlySet<string>,
): DatabaseSqlImportGroup[] {
    const seen = new Set<string>();
    for (const name of catalogObjectNames) seen.add(name.toLowerCase());
    const walked: DatabaseSqlImportGroup[] = [];
    for (const group of groups) {
        const occupied = createIndexName(group.sql);
        if (occupied === null) {
            walked.push(group);
            continue;
        }
        if (occupied.unique && occupied.ifNotExists && seen.has(occupied.key)) continue;
        seen.add(occupied.key);
        walked.push(group);
    }
    return walked;
}

/**
 * Keys of tables the batch creates with CREATE TABLE IF NOT EXISTS, exactly once.
 * A key created more than once, or dropped or renamed at all, is excluded (SQLite keeps
 * the first create, so a later statement must not decide). TEMP tables are never counted.
 */
function collectCreatedTableKeys(groups: DatabaseSqlImportGroup[]): Set<string> {
    const creates = new Map<string, { count: number; guarded: boolean }>();
    const tainted = new Set<string>();
    for (const group of groups) {
        const tokens = tokenizeSql(group.sql);
        const head = wordAt(tokens, 0);
        if (head === 'CREATE') {
            if (wordAt(tokens, 1) === 'TEMP' || wordAt(tokens, 1) === 'TEMPORARY') continue;
            let index = 1;
            while (wordAt(tokens, index) === 'UNIQUE' || wordAt(tokens, index) === 'VIRTUAL') {
                index += 1;
            }
            if (wordAt(tokens, index) !== 'TABLE') continue;
            const skip = skipIfNotExists(tokens, index + 1);
            const name = qualifiedName(tokens, skip.index);
            if (name === null) continue;
            const seen = creates.get(name.key);
            if (seen === undefined) {
                creates.set(name.key, { count: 1, guarded: skip.ifNotExists });
            } else {
                seen.count += 1;
            }
        } else if (head === 'DROP') {
            if (wordAt(tokens, 1) !== 'TABLE') continue;
            let index = 2;
            if (wordAt(tokens, index) === 'IF' && wordAt(tokens, index + 1) === 'EXISTS') index += 2;
            const name = qualifiedName(tokens, index);
            if (name === null) continue;
            tainted.add(name.key);
        } else if (head === 'ALTER') {
            if (wordAt(tokens, 1) !== 'TABLE') continue;
            const from = qualifiedName(tokens, 2);
            if (from === null) continue;
            if (wordAt(tokens, from.next) !== 'RENAME' || wordAt(tokens, from.next + 1) !== 'TO') continue;
            const to = qualifiedName(tokens, from.next + 2);
            if (to === null) continue;
            tainted.add(from.key);
            tainted.add(to.key);
        }
    }
    const created = new Set<string>();
    for (const [key, seen] of creates) {
        if (seen.count === 1 && seen.guarded && !tainted.has(key)) created.add(key);
    }
    return created;
}

/** A libsql lock error: code SQLITE_BUSY* / SQLITE_LOCKED*, or a message matching /database (?:table )?is locked/i. */
export function isLockError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const record = error as { code?: unknown; message?: unknown };
    if (typeof record.code === 'string') {
        const code = record.code.toUpperCase();
        if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) return true;
    }
    return typeof record.message === 'string' && /database (?:table )?is locked/i.test(record.message);
}

/** The wait before lock retry number `attempt` (0-based): min(LOCK_BACKOFF_BASE_MS * 2 ** attempt, LOCK_BACKOFF_MAX_MS, remainingMs); 0 when remainingMs <= 0. */
export function lockBackoffMs(attempt: number, remainingMs: number): number {
    if (!(remainingMs > 0)) return 0;
    return Math.min(LOCK_BACKOFF_BASE_MS * 2 ** attempt, LOCK_BACKOFF_MAX_MS, remainingMs);
}

/** `30s`, `15m`, `1h` or a bare number of seconds, 1 s to 24 h; anything else throws DatabaseOperationError('invalid_timeout', ...). */
export function parseImportTimeoutMs(value: string): number {
    const trimmed = value.trim();
    const match = /^(\d+)([smh]?)$/.exec(trimmed);
    const multiplier = match !== null && match[2] === 'm'
        ? 60_000
        : match !== null && match[2] === 'h'
            ? 3_600_000
            : 1_000;
    const result = match === null ? NaN : Number(match[1]) * multiplier;
    if (match === null || !Number.isSafeInteger(result) || result < 1000 || result > MAX_IMPORT_TIMEOUT_MS) {
        throw new DatabaseOperationError(
            'invalid_timeout',
            `--timeout must look like 30s, 15m or 1h (1 second to 24 hours), got "${trimmed}".`,
        );
    }
    return result;
}
