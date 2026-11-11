/** Pinned copy of app PagesSyncRequest rules, app main blob 16571244ff0d9de5adf94dac069ccb187d864867.
 * deployment_id uses nullable uuid; the exists:deployments,id rule cannot be checked offline.
 * Mirrors the global TrimStrings + ConvertEmptyStringsToNull middleware: a string that is
 * empty after trim counts as absent (null) — required string rules reject it, nullable
 * rules accept it. `array` accepts associative maps as well as lists (PHP arrays). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KINDS = ['sql', 'connection', 'pegs'];
const PAGE_KINDS = ['visual', 'dashboard'];
const BODY_MAX_BYTES = 1048576;

/** Absent after the empty-string-to-null conversion (undefined, null, or blank). */
function isAbsent(value: unknown): boolean {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): boolean {
    return typeof value === 'string' && UUID.test(value.trim());
}

function isLaravelBoolean(value: unknown): boolean {
    const normalized = typeof value === 'string' ? value.trim() : value;
    return normalized === true || normalized === false || normalized === 1 || normalized === 0 || normalized === '1' || normalized === '0';
}

function isHomeTrue(value: unknown): boolean {
    const normalized = typeof value === 'string' ? value.trim() : value;
    return normalized === true || normalized === 1 || normalized === '1';
}

/** Required string: present, non-blank, within max length. */
function isRequiredString(value: unknown, max: number): boolean {
    return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

function isNullableString(value: unknown, max: number): boolean {
    if (isAbsent(value)) return true;
    return typeof value === 'string' && value.length <= max;
}

/** Laravel `array`: lists and associative maps both count. */
function isNullableArrayLike(value: unknown): boolean {
    if (isAbsent(value)) return true;
    return Array.isArray(value) || isRecord(value);
}

/** Laravel `integer`/`min`/`max`: numbers and numeric strings ("5") both count. */
function isNullableInteger(value: unknown, min: number, max: number): boolean {
    if (isAbsent(value)) return true;
    if (typeof value === 'number') return Number.isInteger(value) && value >= min && value <= max;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!/^-?\d+$/.test(trimmed)) return false;
        const parsed = Number(trimmed);
        return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
    }
    return false;
}

export function validatesAgainstAppMain(payload: any): string[] {
    const errors: string[] = [];
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        errors.push('payload: object');
        return errors;
    }
    if (!isAbsent(payload.deployment_id) && !isUuid(payload.deployment_id)) {
        errors.push('deployment_id: nullable uuid');
    }
    const codeRef = payload.code_ref;
    if (!isAbsent(codeRef)) {
        if (typeof codeRef !== 'object' || codeRef === null) {
            errors.push('code_ref: nullable array');
        } else {
            if (!isNullableString(codeRef.branch, 255)) errors.push('code_ref.branch: nullable string max 255');
            if (!isNullableString(codeRef.short_sha, 255)) errors.push('code_ref.short_sha: nullable string max 255');
            if (!isNullableString(codeRef.commit_sha, 255)) errors.push('code_ref.commit_sha: nullable string max 255');
            if (!isAbsent(codeRef.dirty) && !isLaravelBoolean(codeRef.dirty)) {
                errors.push('code_ref.dirty: nullable boolean');
            }
        }
    }
    // Laravel `array` accepts the top-level pages as a list or an associative map.
    const pagesRaw: unknown = (payload as Record<string, unknown>).pages;
    const pagesList: unknown[] = Array.isArray(pagesRaw) ? pagesRaw : isRecord(pagesRaw) ? Object.values(pagesRaw) : [];
    if (!('pages' in payload) || (!Array.isArray(pagesRaw) && !isRecord(pagesRaw)) || pagesList.length > 50) {
        errors.push('pages: present array, max 50');
        return errors;
    }
    for (const [i, page] of pagesList.entries()) {
        const at = `pages.${i}`;
        if (page === null || typeof page !== 'object' || Array.isArray(page)) {
            errors.push(`${at}: object`);
            continue;
        }
        const fields = page as Record<string, unknown>;
        if (typeof fields.slug !== 'string' || fields.slug.trim() === '' || !SLUG.test(fields.slug.trim())) errors.push(`${at}.slug`);
        if (!isRequiredString(fields.name, 255)) errors.push(`${at}.name`);
        if (!PAGE_KINDS.includes(fields.kind as string)) errors.push(`${at}.kind`);
        if (!isRequiredString(fields.path, 255)) errors.push(`${at}.path`);
        if (!isLaravelBoolean(fields.home)) errors.push(`${at}.home`);
        // TrimStrings + ConvertEmptyStringsToNull turn an empty or
        // whitespace-only body into null, which the `string` rule rejects.
        if (!('body' in fields) || typeof fields.body !== 'string' || fields.body.trim() === '' || Buffer.byteLength(fields.body) > BODY_MAX_BYTES) {
            errors.push(`${at}.body`);
        }
        if (!isAbsent(fields.sources)) {
            const container = fields.sources;
            const isArr = Array.isArray(container);
            const isMap = isRecord(container);
            const count = isArr ? container.length : isMap ? Object.keys(container).length : -1;
            if ((!isArr && !isMap) || count > 50) {
                errors.push(`${at}.sources: array, max 50`);
            } else {
                const list: unknown[] = isArr ? container : Object.values(container);
                for (const [j, source] of list.entries()) {
                    const sat = `${at}.sources.${j}`;
                    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
                        errors.push(`${sat}: array/object`);
                        continue;
                    }
                    const fields = source as Record<string, unknown>;
                    if (!isRequiredString(fields.key, 255)) {
                        errors.push(`${sat}.key`);
                    }
                    if (!SOURCE_KINDS.includes(fields.kind as string)) errors.push(`${sat}.kind`);
                    if (!isNullableString(fields.database, 255)) errors.push(`${sat}.database`);
                    if (!isNullableString(fields.connection, 255)) errors.push(`${sat}.connection`);
                    if (!isNullableString(fields.sql, 65535)) errors.push(`${sat}.sql`);
                    if (!isNullableArrayLike(fields.params)) errors.push(`${sat}.params`);
                    if (!isNullableInteger(fields.cache_ttl_seconds, 0, Number.MAX_SAFE_INTEGER)) {
                        errors.push(`${sat}.cache_ttl_seconds`);
                    }
                    if (!isNullableString(fields.action, 128)) errors.push(`${sat}.action`);
                    if (!isNullableString(fields.tool, 128)) errors.push(`${sat}.tool`);
                    if (!isNullableArrayLike(fields.args)) errors.push(`${sat}.args`);
                    if (!isNullableString(fields.rows_path, 255)) errors.push(`${sat}.rows_path`);
                    if (!isAbsent(fields.pegboard_id) && !isUuid(fields.pegboard_id)) {
                        errors.push(`${sat}.pegboard_id`);
                    }
                    if (!isNullableArrayLike(fields.columns)) errors.push(`${sat}.columns`);
                    if (!isNullableArrayLike(fields.filter)) errors.push(`${sat}.filter`);
                    if (!isNullableInteger(fields.limit, 1, 500)) errors.push(`${sat}.limit`);
                }
            }
        }
    }
    const slugs = pagesList.map((page: any) => page?.slug);
    if (new Set(slugs).size !== slugs.length) errors.push('pages: unique slugs');
    if (pagesList.filter((page: any) => isHomeTrue(page?.home)).length > 1) errors.push('pages: at most one home');
    for (const [i, page] of pagesList.entries()) {
        if (page === null || typeof page !== 'object') continue;
        const rawSources = (page as Record<string, unknown>).sources;
        const list: unknown[] = Array.isArray(rawSources) ? rawSources : isRecord(rawSources) ? Object.values(rawSources) : [];
        for (const [j, source] of list.entries()) {
            if (typeof source !== 'object' || source === null || Array.isArray(source)) continue;
            const s = source as Record<string, unknown>;
            const kind = s.kind;
            const hasDatabase = 'database' in s && !isAbsent(s.database);
            const hasConnection = 'connection' in s && !isAbsent(s.connection);
            if (kind === 'sql' || kind === 'connection') {
                if ((hasDatabase ? 1 : 0) + (hasConnection ? 1 : 0) !== 1) {
                    errors.push(`pages.${i}.sources.${j}.database: exactly one of database or connection is required for sql/connection sources`);
                }
            } else if (hasDatabase || hasConnection) {
                errors.push(`pages.${i}.sources.${j}.database: database/connection is only allowed for sql/connection sources`);
            }
        }
    }
    return errors;
}
