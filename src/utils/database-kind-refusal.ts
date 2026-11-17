import { DatabaseOperationError } from './database-data-plane';

/**
 * Frozen contract 3 (wave cli-duckdb, Task 4): the kind-mismatch refusal for
 * the analytical-only verbs (`connect`, `wake`, `optimize`, `drop-table`,
 * `ingest`, `export`) when the named database is not an analytical (duckdb)
 * database.
 *
 * A DuckDB database file gets the sentence naming the kind; a standard
 * (libsql) database keeps the exact sentence each call site threw before
 * (the `ingest` wording for `verb === 'ingest'`, no normalizing). Returns
 * null for an analytical (duckdb) database, which every caller lets through.
 */
export function analyticalVerbKindMismatch(name: string, row: { kind: string }, verb: string): DatabaseOperationError | null {
    if (row.kind === 'duckdb') {
        return null;
    }

    if (row.kind === 'duckdb_file') {
        return new DatabaseOperationError(
            'kind_mismatch',
            `"${name}" is a DuckDB database file — \`database ${verb}\` does not apply to it. Read it with \`database query\` and \`database schema\`; download it with \`database pull\`; see its history with \`database versions\` and \`database rollback\`.`,
        );
    }

    if (verb === 'ingest') {
        return new DatabaseOperationError(
            'kind_mismatch',
            `"${name}" is not an analytical database — \`database ingest\` only loads data into analytical (duckdb) databases.`,
        );
    }

    return new DatabaseOperationError(
        'kind_mismatch',
        `"${name}" is not an analytical database — \`database ${verb}\` only works on analytical (duckdb) databases.`,
    );
}
