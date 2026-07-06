// src/utils/table.ts
//
// Shared plain-text table renderer (extracted from webhook-formatters.ts's
// columnWidth helper) used by project-list, env-list, and run-list.
//
// Operates on PLAIN (uncolored) cell values only — chalk ANSI escape codes
// count toward a JS string's .length, so colorizing a cell before padding
// would corrupt the alignment math. Callers that want color should apply it
// to the whole rendered line (e.g. chalk.gray(lines[i])), not to individual
// cell values passed in here.

export interface RenderTableOptions {
    /** Per-column minimum width (before the +2 separator). */
    minWidths?: number[];
    /** Cells longer than this are truncated with `…`. Default: 60. */
    maxWidth?: number;
}

const DEFAULT_MAX_WIDTH = 60;

/** Escape embedded newlines so a row can never span multiple terminal lines. */
export function sanitizeCell(value: string): string {
    return value.replace(/\r?\n/g, '\\n');
}

export function truncateCell(value: string, maxWidth: number = DEFAULT_MAX_WIDTH): string {
    if (value.length <= maxWidth) return value;
    return value.slice(0, Math.max(0, maxWidth - 1)) + '…';
}

/**
 * Compute per-column widths (`max(minWidth, longest sanitized+truncated cell) + 2`)
 * without rendering — for callers (e.g. run-list) that need to colorize a
 * cell's text with chalk AFTER padding (coloring first would corrupt the
 * alignment math, since ANSI escape codes count toward a JS string's .length).
 */
export function computeColumnWidths(headers: string[], rows: string[][], opts: RenderTableOptions = {}): number[] {
    const maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH;
    const minWidths = opts.minWidths ?? [];
    const clean = (v: string) => truncateCell(sanitizeCell(v), maxWidth);

    return headers.map((h, i) => {
        const longest = Math.max(clean(h).length, ...rows.map((r) => clean(r[i] ?? '').length));
        return Math.max(minWidths[i] ?? 0, longest) + 2;
    });
}

/**
 * Render a simple aligned table as an array of lines: `[header, divider, ...rows]`.
 * Column widths are dynamic — `max(minWidth, longest cell in that column) + 2`.
 */
export function renderTable(headers: string[], rows: string[][], opts: RenderTableOptions = {}): string[] {
    const maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH;
    const minWidths = opts.minWidths ?? [];

    const cleanHeaders = headers.map((h) => truncateCell(sanitizeCell(h), maxWidth));
    const cleanRows = rows.map((row) => row.map((cell) => truncateCell(sanitizeCell(cell), maxWidth)));

    const widths = cleanHeaders.map((h, i) => {
        const longest = Math.max(h.length, ...cleanRows.map((r) => r[i]?.length ?? 0));
        return Math.max(minWidths[i] ?? 0, longest) + 2;
    });

    const renderRow = (cells: string[]): string =>
        cells.map((cell, i) => (i === cells.length - 1 ? cell : (cell ?? '').padEnd(widths[i]))).join('');

    const totalWidth = widths.reduce((a, b) => a + b, 0);

    return [
        renderRow(cleanHeaders),
        '-'.repeat(totalWidth),
        ...cleanRows.map(renderRow),
    ];
}
