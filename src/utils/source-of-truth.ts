import { sanitizeDisplayText } from './source-provenance';

/** Wire value for the app#2584 W2 override; the server accepts it on deploy and the four sync routes. */
export type OverrideSourceOfTruthField = { override_source_of_truth?: 1 };

/**
 * Adds `override_source_of_truth: 1` to a JSON body only when the flag is set.
 * When it is not set the SAME payload object comes back, so a deploy without
 * the flag sends byte-identical bodies to today (design invariant 5).
 */
export function withOverrideSourceOfTruth<T extends object>(payload: T, override: boolean | undefined): T & OverrideSourceOfTruthField {
    return override === true ? { ...payload, override_source_of_truth: 1 as const } : payload;
}

/**
 * The printable server message of a 409 `source_of_truth_git` refusal, or null
 * when the response is anything else. The server text already names the repo
 * and the override flag, so it is printed as is.
 */
export function sourceOfTruthRefusal(status: unknown, body: unknown): string | null {
    if (status !== 409 || body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    if (record.code !== 'source_of_truth_git') return null;
    return sanitizeDisplayText(record.message)
        ?? 'This app\'s source of truth is git. Re-run with --override-source-of-truth to deploy from the sandbox anyway.';
}

/** One printable line per `warnings[]` entry with code `drift`; nothing for any other shape. */
export function driftWarningLines(data: unknown): string[] {
    const warnings = data !== null && typeof data === 'object' ? (data as Record<string, unknown>).warnings : undefined;
    if (!Array.isArray(warnings)) return [];
    return warnings.flatMap((warning: unknown) => {
        if (warning === null || typeof warning !== 'object' || (warning as Record<string, unknown>).code !== 'drift') return [];
        const since = sanitizeDisplayText((warning as Record<string, unknown>).since, 64) ?? 'an unknown date';
        return [`Warning: this app is drifted: deployed outside git since ${since}. Mark it reconciled in the app's settings, or flip its source of truth to SolidActions.`];
    });
}
