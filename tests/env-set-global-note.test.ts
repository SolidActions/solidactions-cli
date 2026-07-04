import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { GLOBAL_ENV_SCOPE_NOTE, envSet } from '../src/commands/env-set';
import { makeTmpEnv, writeGlobal } from './helpers';

describe('GLOBAL_ENV_SCOPE_NOTE content', () => {
    it('explains the scope, the YAML invisibility, and both remedies', () => {
        expect(GLOBAL_ENV_SCOPE_NOTE).toContain('creating a GLOBAL variable');
        expect(GLOBAL_ENV_SCOPE_NOTE).toContain('NOT visible');
        expect(GLOBAL_ENV_SCOPE_NOTE).toContain('solidactions env map');
        expect(GLOBAL_ENV_SCOPE_NOTE).toContain('solidactions env set <project> KEY value');
    });
});

describe('envSet prints the note in global mode only, before the API call', () => {
    let lines: string[];
    const originalLog = console.log;
    let originalGet: typeof axios.get;
    let originalPost: typeof axios.post;
    let env: ReturnType<typeof makeTmpEnv>;
    let firstHttpAfterNoteIndex: number;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(process.env.HOME!, { host: 'http://localhost', apiKey: 'k', workspaceId: 'ws-1' });

        lines = [];
        firstHttpAfterNoteIndex = -1;
        console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };

        originalGet = axios.get;
        originalPost = axios.post;
        // Global-mode calls: GET /api/v1/variables (existence check), then POST create.
        axios.get = (async (url: string) => {
            if (url.includes('/api/v1/variables')) {
                if (firstHttpAfterNoteIndex === -1) firstHttpAfterNoteIndex = lines.length;
                return { data: { data: [] } };
            }
            if (url.includes('variable-mappings')) {
                return { data: [] };
            }
            throw new Error('unexpected GET ' + url);
        }) as any;
        axios.post = (async () => ({ data: { created: 1, updated: 0 } })) as any;
    });

    afterEach(() => {
        console.log = originalLog;
        axios.get = originalGet;
        axios.post = originalPost;
        env.cleanup();
    });

    it('2-arg global form prints the note before any HTTP call and still succeeds', async () => {
        await envSet('MY_GLOBAL', 'value', undefined, { yes: true });

        const noteIndex = lines.findIndex((l) => l.includes('creating a GLOBAL variable'));
        expect(noteIndex).toBeGreaterThanOrEqual(0);
        expect(firstHttpAfterNoteIndex).toBeGreaterThan(noteIndex);
        expect(lines.some((l) => l.includes('created successfully'))).toBe(true);
    });

    it('3-arg project form prints no note', async () => {
        await envSet('my-project', 'MY_KEY', 'value', { yes: true });
        expect(lines.some((l) => l.includes('creating a GLOBAL variable'))).toBe(false);
    });
});
