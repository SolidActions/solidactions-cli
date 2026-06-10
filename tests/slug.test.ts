/**
 * Tests for the shared project-slug helper used by `project create` and
 * `project deploy`.
 */

import { describe, expect, it } from 'vitest';
import { slugifyName, buildProjectSlug } from '../src/utils/slug';

describe('slugifyName', () => {
    it('lowercases and hyphenates spaces', () => {
        expect(slugifyName('My Project')).toBe('my-project');
    });

    it('trims leading/trailing separators', () => {
        expect(slugifyName('  My Project!  ')).toBe('my-project');
        expect(slugifyName('-foo-')).toBe('foo');
    });

    it('collapses runs of non-alphanumerics to a single hyphen', () => {
        expect(slugifyName('a  b')).toBe('a-b');
        expect(slugifyName('my--project')).toBe('my-project');
        expect(slugifyName('foo!!!bar')).toBe('foo-bar');
    });

    it('drops non-Latin / accented characters, keeping the alphanumeric remainder', () => {
        expect(slugifyName('Café')).toBe('caf');
    });

    it('returns empty string when there is nothing usable', () => {
        expect(slugifyName('!!!')).toBe('');
        expect(slugifyName('你好')).toBe('');
        expect(slugifyName('')).toBe('');
    });
});

describe('buildProjectSlug', () => {
    it('returns the bare slug for production', () => {
        expect(buildProjectSlug('My Project', 'production')).toBe('my-project');
    });

    it('appends the environment suffix for non-production', () => {
        expect(buildProjectSlug('My Project', 'dev')).toBe('my-project-dev');
        expect(buildProjectSlug('My Project', 'staging')).toBe('my-project-staging');
    });
});
