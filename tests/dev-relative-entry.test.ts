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
    fs.writeFileSync(
        path.join(projectDir, 'src', 'workflow.ts'),
        'export default { name: "relative-entry", run: async () => 42 };\n',
    );
});

afterAll(() => {
    if (workRoot) fs.rmSync(workRoot, { recursive: true, force: true });
});

function runDevCli(entryArg: string, cwd: string) {
    return childProcess.spawnSync(
        process.execPath,
        [CLI_BINARY, 'dev', entryArg, '--input', '{}'],
        { encoding: 'utf8', cwd, env: { ...process.env }, timeout: 60_000 },
    );
}

describe('solidactions dev — relative entry path from outside the project root', () => {
    it('does not double-resolve the entry against the re-exec child cwd', () => {
        const result = runDevCli(path.join('project_b', 'src', 'workflow.ts'), workRoot);
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

        // The bug's signature: the project directory segment appearing twice.
        expect(output).not.toMatch(/project_b[\\/]project_b/);
        // And more generally, the entry must be found at all.
        expect(output).not.toMatch(/File not found/);
    }, 90_000);

    it('still resolves an absolute entry path from outside the project root', () => {
        const result = runDevCli(path.join(projectDir, 'src', 'workflow.ts'), workRoot);
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

        expect(output).not.toMatch(/File not found/);
    }, 90_000);
});
