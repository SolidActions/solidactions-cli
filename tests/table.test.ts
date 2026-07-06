/**
 * F-C8 — shared table renderer (extracted from webhook-formatters.ts's
 * columnWidth helper). Pure-function unit tests.
 */
import { describe, expect, it } from 'vitest';
import { renderTable, computeColumnWidths } from '../src/utils/table';

describe('renderTable', () => {
    it('separates columns by at least 2 spaces past the longest cell', () => {
        const lines = renderTable(['NAME', 'STATUS'], [['a', 'ready']]);
        expect(lines[0]).toMatch(/^NAME\s{2,}STATUS$/);
    });

    it('dynamic width grows to fit the longest cell in a column, not just the header', () => {
        const lines = renderTable(['NAME', 'STATUS'], [['a-very-long-project-name', 'ready']]);
        // The first column's width (before STATUS starts) must accommodate the
        // long value plus the 2-space separator, not just the "NAME" header.
        const dataRow = lines[2];
        expect(dataRow.indexOf('ready')).toBe('a-very-long-project-name'.length + 2);
    });

    it('truncates a cell longer than maxWidth with a trailing ellipsis', () => {
        const longValue = 'x'.repeat(100);
        const lines = renderTable(['NAME'], [[longValue]], { maxWidth: 20 });
        const dataRow = lines[2];
        expect(dataRow.length).toBeLessThanOrEqual(22);
        expect(dataRow).toContain('…');
    });

    it('escapes an embedded newline so a row never spans multiple lines', () => {
        const lines = renderTable(['NAME'], [['line1\nline2']]);
        expect(lines).toHaveLength(3); // header + divider + exactly one data row
        expect(lines[2]).toContain('line1\\nline2');
        expect(lines[2]).not.toContain('\n');
    });

    it('respects an explicit minWidth even when all cell values are short', () => {
        const lines = renderTable(['A', 'B'], [['x', 'y']], { minWidths: [10] });
        const dataRow = lines[2];
        expect(dataRow.indexOf('y')).toBeGreaterThanOrEqual(12);
    });

    it('renders one row per input row, in the given order', () => {
        const lines = renderTable(['NAME'], [['first'], ['second'], ['third']]);
        expect(lines).toHaveLength(5); // header + divider + 3 rows
        expect(lines[2].trim()).toBe('first');
        expect(lines[3].trim()).toBe('second');
        expect(lines[4].trim()).toBe('third');
    });
});

describe('computeColumnWidths', () => {
    it('computes max(minWidth, longest cell) + 2 per column — for callers that colorize then pad', () => {
        const headers = ['ID', 'STATUS'];
        const rows = [['1', 'completed'], ['123456', 'failed']];
        const widths = computeColumnWidths(headers, rows, { minWidths: [8, 12] });
        // col0: longest('ID','1','123456') = 6, min 8 -> max(8,6)+2 = 10
        // col1: longest('STATUS','completed','failed') = 9, min 12 -> max(12,9)+2 = 14
        expect(widths).toEqual([10, 14]);
    });

    it('grows past minWidth when the longest cell exceeds it', () => {
        const widths = computeColumnWidths(['NAME'], [['a-very-long-value-past-min']], { minWidths: [5] });
        expect(widths[0]).toBe('a-very-long-value-past-min'.length + 2);
    });
});
