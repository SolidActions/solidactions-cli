import { DatabaseOperationError } from './database-data-plane';

const MAX_IMPORT_GROUP_BYTES = 8 * 1024 * 1024;
const INCOMPLETE_DOWNLOAD_MARKER = /(?:^|\n)[\t ]*--[\t ]+DOWNLOAD INCOMPLETE\b/;

export interface DatabaseSqlImportGroup {
    sql: string;
    startByte: number;
    endByte: number;
    startLine: number;
    endLine: number;
}

export interface ParsedDatabaseImportSql {
    groups: DatabaseSqlImportGroup[];
    foreignKeysOff: boolean;
}

interface SqlToken {
    value: string;
    line: number;
}

interface ScannedGroup extends DatabaseSqlImportGroup {
    tokens: SqlToken[];
}

function importError(message: string): DatabaseOperationError {
    return new DatabaseOperationError('import_failed', message);
}

function decodeSource(source: Buffer | string): { text: string; byteBase: number } {
    if (typeof source === 'string') {
        if (source.startsWith('\uFEFF')) {
            const text = source.slice(1);
            if (text.startsWith('\uFEFF')) {
                throw importError('The SQL import source has more than one leading UTF-8 BOM.');
            }
            return { text, byteBase: 3 };
        }
        return { text: source, byteBase: 0 };
    }

    const hasBom = source.length >= 3
        && source[0] === 0xef
        && source[1] === 0xbb
        && source[2] === 0xbf;
    let text: string;
    try {
        // TextDecoder consumes the first UTF-8 BOM. A second BOM remains in
        // the decoded text and is deliberately not normalized away.
        text = new TextDecoder('utf-8', { fatal: true }).decode(source);
    } catch {
        throw importError('The SQL import source is not valid UTF-8.');
    }
    if (hasBom && text.startsWith('\uFEFF')) {
        throw importError('The SQL import source has more than one leading UTF-8 BOM.');
    }
    return { text, byteBase: hasBom ? 3 : 0 };
}

function codePointWidth(text: string, index: number): number {
    const point = text.codePointAt(index);
    return point !== undefined && point > 0xffff ? 2 : 1;
}

function byteOffsets(text: string, byteBase: number): Uint32Array {
    const offsets = new Uint32Array(text.length + 1);
    let bytes = byteBase;
    let index = 0;

    while (index < text.length) {
        offsets[index] = bytes;
        const width = codePointWidth(text, index);
        if (width === 2) offsets[index + 1] = bytes;
        bytes += Buffer.byteLength(text.slice(index, index + width), 'utf8');
        index += width;
        offsets[index] = bytes;
    }

    return offsets;
}

function isWhitespace(character: string): boolean {
    return /\s/u.test(character);
}

function isIdentifierStart(character: string): boolean {
    return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string): boolean {
    return /[A-Za-z0-9_$]/.test(character);
}

function isTriggerDeclaration(tokens: SqlToken[]): boolean {
    if (tokens[0]?.value !== 'CREATE') return false;
    if (tokens[1]?.value === 'TRIGGER') return true;
    return ['TEMP', 'TEMPORARY'].includes(tokens[1]?.value)
        && tokens[2]?.value === 'TRIGGER';
}

function scanDatabaseSqlGroupsWithTokens(text: string, byteBase = 0): ScannedGroup[] {
    const offsets = byteOffsets(text, byteBase);
    const groups: ScannedGroup[] = [];
    let index = 0;
    let line = 1;
    let groupStart = -1;
    let groupStartLine = 1;
    let hasSql = false;
    let tokens: SqlToken[] = [];
    let trigger = false;
    let triggerBeginDepth = 0;
    let triggerCaseDepth = 0;
    let triggerEnded = false;

    const advance = () => {
        if (text[index] === '\n') line += 1;
        index += codePointWidth(text, index);
    };

    const startGroup = () => {
        if (groupStart < 0) {
            groupStart = index;
            groupStartLine = line;
        }
    };

    const resetGroup = () => {
        groupStart = -1;
        groupStartLine = line;
        hasSql = false;
        tokens = [];
        trigger = false;
        triggerBeginDepth = 0;
        triggerCaseDepth = 0;
        triggerEnded = false;
    };

    const finishGroup = (endIndex: number, endLine: number) => {
        const startByte = offsets[groupStart];
        const endByte = offsets[endIndex];
        if (endByte - startByte > MAX_IMPORT_GROUP_BYTES) {
            throw importError(`SQL statement at line ${groupStartLine} exceeds the 8 MiB import limit.`);
        }

        groups.push({
            sql: text.slice(groupStart, endIndex),
            startByte,
            endByte,
            startLine: groupStartLine,
            endLine,
            tokens,
        });
        resetGroup();
    };

    const scanQuoted = (closing: string, doubledEscape: boolean) => {
        const quoteLine = line;
        advance();
        while (index < text.length) {
            if (text[index] === closing) {
                if (doubledEscape && text[index + 1] === closing) {
                    advance();
                    advance();
                    continue;
                }
                advance();
                return;
            }
            advance();
        }
        throw importError(`Unterminated SQL quote at line ${quoteLine}.`);
    };

    while (index < text.length) {
        const character = text[index];

        if (isWhitespace(character)) {
            advance();
            continue;
        }

        if (character === '-' && text[index + 1] === '-') {
            startGroup();
            advance();
            advance();
            while (index < text.length && text[index] !== '\n') advance();
            continue;
        }

        if (character === '/' && text[index + 1] === '*') {
            const commentLine = line;
            startGroup();
            advance();
            advance();
            let closed = false;
            while (index < text.length) {
                if (text[index] === '*' && text[index + 1] === '/') {
                    advance();
                    advance();
                    closed = true;
                    break;
                }
                advance();
            }
            if (!closed) throw importError(`Unterminated SQL comment at line ${commentLine}.`);
            continue;
        }

        startGroup();
        hasSql = true;

        if (character === '\'' || character === '"' || character === '`') {
            scanQuoted(character, true);
            continue;
        }

        if (character === '[') {
            scanQuoted(']', true);
            continue;
        }

        if (isIdentifierStart(character)) {
            const tokenLine = line;
            const tokenStart = index;
            while (index < text.length && isIdentifierPart(text[index])) advance();
            const value = text.slice(tokenStart, index).toUpperCase();
            tokens.push({ value, line: tokenLine });

            if (!trigger && isTriggerDeclaration(tokens)) trigger = true;
            if (trigger) {
                if (triggerBeginDepth === 0 && !triggerEnded && value === 'BEGIN') {
                    triggerBeginDepth = 1;
                } else if (triggerBeginDepth > 0 && !triggerEnded) {
                    if (value === 'CASE') {
                        triggerCaseDepth += 1;
                    } else if (value === 'BEGIN' && triggerCaseDepth === 0) {
                        triggerBeginDepth += 1;
                    } else if (value === 'END') {
                        if (triggerCaseDepth > 0) {
                            triggerCaseDepth -= 1;
                        } else {
                            triggerBeginDepth -= 1;
                            if (triggerBeginDepth === 0) triggerEnded = true;
                        }
                    }
                }
            }
            continue;
        }

        if (character === ';') {
            const endLine = line;
            advance();
            if (!trigger || triggerEnded) finishGroup(index, endLine);
            continue;
        }

        advance();
    }

    if (hasSql) {
        if (trigger) {
            throw importError(`Incomplete SQL trigger at line ${groupStartLine}.`);
        }
        throw importError(`Incomplete SQL statement at line ${groupStartLine}; a complete boundary could not be proven.`);
    }

    return groups;
}

/**
 * Scan complete SQLite statement groups without interpreting transaction or
 * PRAGMA policy. Import normalization builds on this scanner, while the
 * foreground SQL session can reuse the same quote/comment/trigger boundaries.
 */
export function scanDatabaseSqlGroups(text: string, byteBase = 0): DatabaseSqlImportGroup[] {
    return scanDatabaseSqlGroupsWithTokens(text, byteBase).map(({ tokens: _tokens, ...group }) => group);
}

export interface AccumulatedDatabaseSql {
    sql: string;
    multiple: boolean;
}

/**
 * Incrementally frame complete SQLite input using the same quote, comment,
 * identifier, and trigger grammar as SQL imports.
 */
export class DatabaseSqlStatementAccumulator {
    private lines: string[] = [];

    get pending(): boolean {
        return this.lines.some((line) => line.trim() !== '');
    }

    push(line: string): AccumulatedDatabaseSql | null {
        if (!this.pending && line.trim() === '') return null;
        this.lines.push(line);
        const sql = this.lines.join('\n');
        let groups: ScannedGroup[];

        try {
            groups = scanDatabaseSqlGroupsWithTokens(sql);
        } catch (error) {
            if (
                error instanceof DatabaseOperationError
                && /^(?:Unterminated|Incomplete) SQL\b/.test(error.message)
            ) {
                return null;
            }
            throw error;
        }

        if (groups.length === 0) return null;

        const first = sqlWithoutLeadingComments(groups[0].sql);
        const last = sqlWithoutLeadingComments(groups[groups.length - 1].sql);
        const explicitTransaction = /^BEGIN(?:\s+TRANSACTION)?\s*;$/i.test(first);
        if (explicitTransaction && !/^(?:COMMIT|END|ROLLBACK)\s*;$/i.test(last)) {
            return null;
        }

        this.lines = [];
        return {
            sql,
            multiple: explicitTransaction || groups.length > 1,
        };
    }
}

type GroupKind =
    | 'ordinary'
    | 'foreign-keys-off'
    | 'foreign-keys-on'
    | 'begin'
    | 'commit'
    | 'pragma'
    | 'transaction';

function sqlWithoutLeadingComments(sql: string): string {
    let index = 0;
    while (index < sql.length) {
        while (index < sql.length && isWhitespace(sql[index])) index += codePointWidth(sql, index);
        if (sql[index] === '-' && sql[index + 1] === '-') {
            index += 2;
            while (index < sql.length && sql[index] !== '\n') index += codePointWidth(sql, index);
            continue;
        }
        if (sql[index] === '/' && sql[index + 1] === '*') {
            const close = sql.indexOf('*/', index + 2);
            index = close < 0 ? sql.length : close + 2;
            continue;
        }
        break;
    }
    return sql.slice(index).trim();
}

function classifyGroup(group: ScannedGroup): GroupKind {
    const values = group.tokens.map((token) => token.value);
    const first = values[0] ?? '';
    const semanticSql = sqlWithoutLeadingComments(group.sql);

    if (first === 'PRAGMA') {
        if (/^PRAGMA\s+foreign_keys\s*=\s*OFF\s*;$/i.test(semanticSql)) {
            return 'foreign-keys-off';
        }
        if (/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;$/i.test(semanticSql)) {
            return 'foreign-keys-on';
        }
        return 'pragma';
    }

    if (/^BEGIN(?:\s+TRANSACTION)?\s*;$/i.test(semanticSql)) {
        return 'begin';
    }
    if (/^COMMIT\s*;$/i.test(semanticSql)) return 'commit';
    if (['BEGIN', 'END', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(first)) {
        return 'transaction';
    }

    return 'ordinary';
}

function rejectDisallowedGroup(group: ScannedGroup, kind: GroupKind): void {
    const first = group.tokens[0];
    const line = first?.line ?? group.startLine;

    if (kind === 'pragma' || kind === 'foreign-keys-off' || kind === 'foreign-keys-on') {
        const name = group.tokens[1]?.value.toLowerCase() ?? 'unknown';
        throw importError(`Unsupported PRAGMA ${name} at line ${line}.`);
    }

    if (kind === 'begin' || kind === 'commit' || kind === 'transaction') {
        const control = first?.value ?? 'TRANSACTION';
        throw importError(`Unsupported top-level ${control} at line ${line}.`);
    }
}

export function parseDatabaseImportSql(source: Buffer | string): ParsedDatabaseImportSql {
    const decoded = decodeSource(source);
    if (INCOMPLETE_DOWNLOAD_MARKER.test(decoded.text.replace(/\r\n/g, '\n'))) {
        throw importError('The SQL import source contains an incomplete download marker.');
    }

    const scanned = scanDatabaseSqlGroupsWithTokens(decoded.text, decoded.byteBase);
    if (scanned.length === 0) return { groups: [], foreignKeysOff: false };

    const kinds = scanned.map(classifyGroup);
    let first = 0;
    let last = scanned.length;
    let foreignKeysOff = false;

    if (kinds[first] === 'foreign-keys-off') {
        foreignKeysOff = true;
        first += 1;
    }

    const hasCanonicalBegin = kinds[first] === 'begin';
    if (hasCanonicalBegin) first += 1;

    if (kinds[last - 1] === 'foreign-keys-on') last -= 1;
    const hasCanonicalCommit = kinds[last - 1] === 'commit';
    if (hasCanonicalCommit) last -= 1;

    const canonicalEnvelope = hasCanonicalBegin && hasCanonicalCommit;
    if (!canonicalEnvelope) {
        for (let index = 0; index < scanned.length; index += 1) {
            rejectDisallowedGroup(scanned[index], kinds[index]);
        }
    }

    const inner = canonicalEnvelope ? scanned.slice(first, last) : scanned;
    const innerKinds = canonicalEnvelope ? kinds.slice(first, last) : kinds;
    for (let index = 0; index < inner.length; index += 1) {
        rejectDisallowedGroup(inner[index], innerKinds[index]);
    }

    return {
        foreignKeysOff: canonicalEnvelope && foreignKeysOff,
        groups: inner.map(({ tokens: _tokens, ...group }) => group),
    };
}
