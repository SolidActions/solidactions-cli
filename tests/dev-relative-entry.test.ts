/**
 * #85 — `solidactions dev <relative-path>` run from OUTSIDE the project root.
 *
 * reexecUnderTsx() forwards the entry path to the tsx child while setting the
 * child's cwd to the entry's own project root. Forwarding the ORIGINAL, possibly
 * relative, argument therefore made the child resolve it a second time against a
 * different cwd, so `cd /tmp && solidactions dev project_b/src/workflow.ts` died
 * with `File not found: /tmp/project_b/project_b/src/workflow.ts`.
 *
 * Test-double policy: no mocks. This spawns the real built CLI under plain
 * `node` (not tsx) from a cwd outside the fixture project, which is the only way
 * to exercise the re-exec path end to end.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let workRoot: string;
let projectDir: string;

beforeAll(() => {
    if (!fs.existsSync(CLI_BINARY)) {
        throw new Error(`CLI not built — run \`npm run build\` first (expected: ${CLI_BINARY})`);
    }

    // <workRoot>/project_b/src/workflow.ts — the CLI is invoked FROM workRoot
    // with the relative path "project_b/src/workflow.ts".
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solidactions-dev-relative-'));
    projectDir = path.join(workRoot, 'project_b');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'project_b', type: 'module' }) + '\n',
    );
    // The fixture must actually RUN, not merely get past path resolution, so the
    // assertions below can require exit 0 and real output. That needs
    // @solidactions/sdk resolvable from the fixture: link this repo's
    // node_modules rather than paying an npm install per test run.
    fs.symlinkSync(
        path.resolve(__dirname, '../node_modules'),
        path.join(projectDir, 'node_modules'),
        'dir',
    );
    fs.writeFileSync(
        path.join(projectDir, 'src', 'workflow.ts'),
        [
            "import { defineWorkflow } from '@solidactions/sdk';",
            'export default defineWorkflow({',
            "    name: 'relative-entry',",
            '    run: async (ctx) => {',
            '        const input = ctx.input as { n?: number };',
            '        return (input.n ?? 0) + 1;',
            '    },',
            '});',
            '',
        ].join('\n'),
    );
});

afterAll(() => {
    if (workRoot) fs.rmSync(workRoot, { recursive: true, force: true });
});

function runDevCli(entryArg: string, cwd: string) {
    return childProcess.spawnSync(
        process.execPath,
        [CLI_BINARY, 'dev', entryArg, '--input', '{"n":41}'],
        { encoding: 'utf8', cwd, env: { ...process.env }, timeout: 60_000 },
    );
}

/**
 * Assert the run actually SUCCEEDED.
 *
 * Asserting only the absence of "File not found" is too weak: a spawn error, a
 * timeout, or a nonzero exit for some unrelated reason would all sail through.
 * This fixture is built to run for real, so require the whole contract — no
 * spawn error, exit 0, and the workflow's own output (41 + 1 = 42).
 */
function expectSuccessfulRun(result: childProcess.SpawnSyncReturns<string>) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.error).toBeUndefined();
    expect(output).not.toMatch(/File not found/);
    expect(result.status, `dev exited ${result.status}\n${output}`).toBe(0);
    expect(output).toMatch(/completed/);
    expect(output).toMatch(/Output:.*\b42\b/);
}

describe('solidactions dev — relative entry path from outside the project root', () => {
    it('does not double-resolve the entry against the re-exec child cwd', () => {
        const result = runDevCli(path.join('project_b', 'src', 'workflow.ts'), workRoot);

        // The bug's signature: the project directory segment appearing twice.
        expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).not.toMatch(/project_b[\\/]project_b/);
        expectSuccessfulRun(result);
    }, 90_000);

    it('still resolves an absolute entry path from outside the project root', () => {
        const result = runDevCli(path.join(projectDir, 'src', 'workflow.ts'), workRoot);

        expectSuccessfulRun(result);
    }, 90_000);
});
