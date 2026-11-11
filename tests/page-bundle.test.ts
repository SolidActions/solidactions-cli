/**
 * page-bundle tests (cli#236).
 *
 * Every case builds a real project in a temp dir and bundles it with the
 * real pinned esbuild; refusals reject with PageBundleError. No mocks.
 * Row 1 is the positive control for the refusal rows: the same machinery
 * succeeding proves a refusal row's setup reached the guarded path (a
 * missing entry or unreadable fixture would reject with a different
 * message than the one each refusal row pins).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { assembleSources, bundlePage, PageBundleError, readAdmitted } from '../src/utils/page-bundle';

const COMPUTED_SPECIFIER =
    "import() and require() of a computed specifier are not allowed in a page; import platform modules by name: react, react-dom, recharts, @tanstack/react-table, sa";
const NO_DEFAULT_EXPORT = 'a page must export its component as the default export';

function makeProject(): { root: string; remove: () => void } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-bundle-')));
    return {
        root,
        remove: () => {
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

function writeFile(root: string, rel: string, text: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
}

function toPosixPath(value: string): string {
    return value.split(path.sep).join('/');
}

// Whether the kernel exposes open-file paths (Linux with /proc). The
// directory-swap rows pin the kernel refusal only where it exists and
// pin the fallback refusal elsewhere.
const HAS_PROC = fs.existsSync('/proc/self/fd');

// Balanced-brace match from an opening brace, string- and comment-aware
// so an interpolation cannot end the scan early. Shared by the source
// sweep rows; returns the index of the matching close, or -1.
function matchBraces(src: string, openIdx: number): number {
    let depth = 0;
    let quote: '"' | "'" | '`' | null = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    const templateStack: number[] = [];
    let j = openIdx;
    while (j < src.length) {
        const ch = src.charAt(j);
        const next = src.charAt(j + 1);
        if (lineComment) {
            if (ch === '\n') {
                lineComment = false;
            }
        } else if (blockComment) {
            if (ch === '*' && next === '/') {
                blockComment = false;
                j += 1;
            }
        } else if (quote !== null) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === quote) {
                quote = null;
            } else if (quote === '`' && ch === '$' && next === '{') {
                templateStack.push(depth);
                quote = null;
                depth += 1;
                j += 1;
            }
        } else if (ch === '/' && next === '/') {
            lineComment = true;
        } else if (ch === '/' && next === '*') {
            blockComment = true;
            j += 1;
        } else if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
        } else if (ch === '{') {
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (templateStack.length > 0 && depth === templateStack[templateStack.length - 1]) {
                templateStack.pop();
                quote = '`';
            } else if (depth === 0 && templateStack.length === 0) {
                return j;
            }
        }
        j += 1;
    }
    return -1;
}

/** Row 1's fixture, reused by rows 3 and 10. */
function writeRow1Project(root: string): { board: string; format: string; card: string } {
    const board = `import React from 'react';
import { formatTitle } from '../lib/format';
import { Card } from '../lib/Card';
import { mark } from 'fake-chart';

export default function Board(): React.ReactElement {
    return <Card title={formatTitle('board')}>{mark}</Card>;
}
`;
    const format = `export function formatTitle(title: string): string {
    return \`TITLE:\${title}\`;
}
`;
    const card = `import React from 'react';

export function Card({ title, children }: { title: string; children?: React.ReactNode }): React.ReactElement {
    return <section data-card={title}>{children}</section>;
}
`;
    writeFile(root, 'pages/board.tsx', board);
    writeFile(root, 'lib/format.ts', format);
    writeFile(root, 'lib/Card.tsx', card);
    writeFile(root, 'node_modules/fake-chart/package.json', '{"name":"fake-chart","version":"1.0.0","main":"index.js"}');
    writeFile(root, 'node_modules/fake-chart/index.js', `import './style.css';
export const mark = 'FAKE_CHART_MARK';
`);
    writeFile(root, 'node_modules/fake-chart/style.css', '.fake{color:red}\n');
    return { board, format, card };
}

async function rejectsWith(entryText: string, root: string, entryRel = 'pages/board.tsx'): Promise<PageBundleError> {
    writeFile(root, entryRel, entryText);
    const error: unknown = await bundlePage(entryRel, root).then(
        () => null,
        (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(PageBundleError);
    return error as PageBundleError;
}

describe('bundlePage', () => {
    // Brief row 1.
    it('bundles an entry with lib files and one npm package into one module and one stylesheet', async () => {
        const { root, remove } = makeProject();
        try {
            writeRow1Project(root);

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(bundle.compiled.startsWith('globalThis.__saPlatform.define(function () {\n')).toBe(true);
            expect(bundle.compiled.endsWith('});\n')).toBe(true);
            expect(bundle.compiled).toContain('FAKE_CHART_MARK');
            expect(bundle.compiled).toContain('TITLE:');
            expect(bundle.compiled).toContain('data-card');
            expect(bundle.compiled).toContain('globalThis.__saPlatform.mount(');
            expect(bundle.compiledCss).toContain('.fake');
            expect(bundle.compiled).not.toContain('import ');
            // __require is esbuild's own CJS interop helper (`__require`
            // has no word boundary before `require`, so the pin below never
            // matches it); what must be gone is any real require call of a
            // bundled relative or package path, in any quoting form.
            expect(bundle.compiled).not.toMatch(/\brequire\(\s*["'`](\.{0,2}\/|fake-chart)/);
        } finally {
            remove();
        }
    });

    // Brief row 2.
    it('leaves the six platform modules external as host module shims', async () => {
        const { root, remove } = makeProject();
        try {
            writeFile(
                root,
                'page.tsx',
                `import React from 'react';
import ReactDOM from 'react-dom';
import { LineChart } from 'recharts';
import { useReactTable } from '@tanstack/react-table';
import sa from 'sa';
import sdk from '@solidactions/sa';

export default function Page(): React.ReactElement {
    return <div>{String([ReactDOM, LineChart, useReactTable, sa, sdk])}</div>;
}
`,
            );

            const bundle = await bundlePage('page.tsx', root);

            for (const name of ['react', 'react-dom', 'recharts', '@tanstack/react-table', 'sa', '@solidactions/sa']) {
                expect(bundle.compiled).toContain(`globalThis.__saPlatform.modules[${JSON.stringify(name)}]`);
            }
            expect(Object.keys(bundle.sources).sort()).toEqual(['page.tsx']);
        } finally {
            remove();
        }
    });

    // Brief row 3.
    it('records every project file read, posix keys, with the esbuild version', async () => {
        const { root, remove } = makeProject();
        try {
            const { board, format, card } = writeRow1Project(root);

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(Object.keys(bundle.sources).sort()).toEqual(['lib/Card.tsx', 'lib/format.ts', 'pages/board.tsx']);
            expect(bundle.sources['pages/board.tsx']).toBe(board);
            expect(bundle.sources['lib/format.ts']).toBe(format);
            expect(bundle.sources['lib/Card.tsx']).toBe(card);
            expect(bundle.compilerVersion).toBe('0.28.2');
        } finally {
            remove();
        }
    });

    // Brief row 4.
    it('pins esbuild to exactly 0.28.2 in package.json', () => {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
        };

        expect(pkg.dependencies?.esbuild).toBe('0.28.2');
    });

    // Brief row 5.
    it('refuses an entry without a default export and a plain CJS entry', async () => {
        for (const entryText of ['export const x = 1;\n', 'module.exports = 1;\n']) {
            const { root, remove } = makeProject();
            try {
                const error = await rejectsWith(entryText, root);

                expect(error.message).toBe(NO_DEFAULT_EXPORT);
            } finally {
                remove();
            }
        }
    });

    // Brief row 6.
    it('names the file and line of a syntax error', async () => {
        const { root, remove } = makeProject();
        try {
            const error = await rejectsWith(
                `import React from 'react';
export default function Board(): React.ReactElement {
    const = 5;
    return <div />;
}
`,
                root,
            );

            expect(error.message.startsWith('pages/board.tsx:3:')).toBe(true);
        } finally {
            remove();
        }
    });

    // Brief row 7.
    it('compiles JSX with React.createElement even when the project tsconfig asks for react-jsx', async () => {
        const { root, remove } = makeProject();
        try {
            writeFile(root, 'tsconfig.json', '{"compilerOptions":{"jsx":"react-jsx"}}');
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';

export default function Board(): React.ReactElement {
    return <div />;
}
`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            // The external React shim is imported as import_react, so the
            // classic call reads import_react.default.createElement(...):
            // pin the call, not esbuild's import alias.
            expect(bundle.compiled).toContain('createElement("div"');
            expect(bundle.compiled).not.toContain('react/jsx-runtime');
        } finally {
            remove();
        }
    });

    // Brief row 8.
    it('refuses an entry that imports a file outside the project directory', async () => {
        const { root, remove } = makeProject();
        try {
            writeFile(root, 'outside.ts', `export const OUTSIDE_MARKER = 'must-never-ship';\n`);

            const error = await rejectsWith(`import React from 'react';
import { OUTSIDE_MARKER } from '../../outside';

export default function Board(): React.ReactElement {
    return <div>{OUTSIDE_MARKER}</div>;
}
`, `${root}/proj`, 'pages/board.tsx');

            expect(error.message).toContain('outside.ts');
            expect(error.message).toContain('outside the project directory');
            expect(error.message).not.toContain('must-never-ship');
        } finally {
            remove();
        }
    });

    // Brief row 9.
    it.skipIf(process.platform === 'win32')('refuses an entry reached through a symlink that points outside', async () => {
        const { root, remove } = makeProject();
        try {
            const target = path.join(root, 'outside-lib');
            fs.mkdirSync(target, { recursive: true });
            writeFile(root, 'outside-lib/x.ts', `export const OUTSIDE_MARKER = 'must-never-ship';\n`);
            fs.mkdirSync(path.join(root, 'proj', 'pages'), { recursive: true });
            fs.symlinkSync(target, path.join(root, 'proj', 'lib'));

            const error = await rejectsWith(`import React from 'react';
import { OUTSIDE_MARKER } from '../lib/x';

export default function Board(): React.ReactElement {
    return <div>{OUTSIDE_MARKER}</div>;
}
`, `${root}/proj`, 'pages/board.tsx');

            expect(error.message).toContain('outside-lib');
            expect(error.message).toContain('outside the project directory');
            expect(error.message).not.toContain('must-never-ship');
        } finally {
            remove();
        }
    });

    // Fix round 1 (finding 1a): an entry that is itself a symlink to a file
    // inside the project bundles by the real file — esbuild keys metafile
    // inputs by real path, so the lexical entry path would miss. Skips on
    // win32 (symlink privileges), like row 9.
    it.skipIf(process.platform === 'win32')('bundles an entry reached through a symlink inside the project', async () => {
        const { root, remove } = makeProject();
        try {
            writeFile(root, 'real/board.tsx', `import React from 'react';\n\nexport default function Board(): React.ReactElement {\n    return <div>REAL_BOARD</div>;\n}\n`);
            fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
            fs.symlinkSync(path.join(root, 'real/board.tsx'), path.join(root, 'pages/board.tsx'));

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(Object.keys(bundle.sources).sort()).toEqual(['real/board.tsx']);
            expect(bundle.compiled).toContain('REAL_BOARD');
        } finally {
            remove();
        }
    });

    // Fix round 1 (finding 1b): an entry that is a symlink pointing outside
    // the project is refused as outside (not as a missing default export):
    // the resolved entry still matches its metafile key, so the outside
    // check in the sources loop fires. Skips on win32, like row 9.
    it.skipIf(process.platform === 'win32')('refuses an entry symlink pointing outside the project', async () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            // Plain TS (no JSX): a .ts target with JSX would fail parsing
            // before the outside check ever runs.
            fs.writeFileSync(path.join(outside, 'x.ts'), `export default function Outside(): string {\n    return 'OUTSIDE_MARKER';\n}\n`);
            fs.mkdirSync(path.join(root, 'proj', 'pages'), { recursive: true });
            fs.symlinkSync(path.join(outside, 'x.ts'), path.join(root, 'proj', 'pages', 'board.tsx'));

            const error = await bundlePage('pages/board.tsx', `${root}/proj`).then(
                () => null,
                (cause: unknown) => cause,
            );

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('outside the project directory');
            expect((error as PageBundleError).message).not.toContain('OUTSIDE_MARKER');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // Fix round 2: an entry symlink to an outside COMMONJS file is refused
    // as outside (not as a missing default export): the resolved entry is
    // checked against the project root before the format check. The
    // fixture carries a marker string so the row can pin that the outside
    // file's text appears in nothing returned. Skips on win32, like row 9.
    it.skipIf(process.platform === 'win32')('refuses an entry symlink to an outside CommonJS file', async () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.writeFileSync(path.join(outside, 'x.js'), `module.exports = 'OUTSIDE_CJS_MARKER';\n`);
            fs.mkdirSync(path.join(root, 'proj', 'pages'), { recursive: true });
            fs.symlinkSync(path.join(outside, 'x.js'), path.join(root, 'proj', 'pages', 'board.tsx'));

            const error = await bundlePage('pages/board.tsx', `${root}/proj`).then(
                () => null,
                (cause: unknown) => cause,
            );

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('outside the project directory');
            expect((error as PageBundleError).message).not.toContain('OUTSIDE_CJS_MARKER');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // Fix round 1 (finding 2): `..` refuses only as a full path component —
    // files and directories that merely start with dots are valid project
    // paths and must bundle (rows 8 and 9 keep refusing real outside files).
    it('bundles project files whose names start with dots', async () => {
        const { root, remove } = makeProject();
        try {
            writeFile(root, 'lib/..shared.ts', `export const s = 'DOTDOT_SHARED';\n`);
            writeFile(root, '..lib/x.ts', `export const x = 'DOTDOT_LIB';\n`);
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport { s } from '../lib/..shared';\nimport { x } from '../..lib/x';\n\nexport default function Board(): React.ReactElement {\n    return <div>{s}{x}</div>;\n}\n`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(Object.keys(bundle.sources).sort()).toEqual(['..lib/x.ts', 'lib/..shared.ts', 'pages/board.tsx']);
            expect(bundle.compiled).toContain('DOTDOT_SHARED');
            expect(bundle.compiled).toContain('DOTDOT_LIB');
        } finally {
            remove();
        }
    });

    // Fix round 1: a missing entry keeps the lexical lookup, so it reports
    // exactly what it always did instead of a raw filesystem error.
    it('refuses a missing entry with the no-default-export message', async () => {
        const { root, remove } = makeProject();
        try {
            const error = await bundlePage('pages/nope.tsx', root).then(
                () => null,
                (cause: unknown) => cause,
            );

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toBe(NO_DEFAULT_EXPORT);
        } finally {
            remove();
        }
    });

    // Brief row 10.
    it('never puts a node_modules path in sources', async () => {
        const { root, remove } = makeProject();
        try {
            writeRow1Project(root);

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(Object.keys(bundle.sources).some((key) => key.includes('node_modules'))).toBe(false);
        } finally {
            remove();
        }
    });

    // Brief row 11.
    it('refuses platform subpath imports by name', async () => {
        const { root, remove } = makeProject();
        try {
            writeFile(root, 'node_modules/fake-ui/package.json', '{"name":"fake-ui","version":"1.0.0","main":"index.js"}');
            writeFile(
                root,
                'node_modules/fake-ui/index.js',
                `import { jsx } from 'react/jsx-runtime';
export const widget = jsx;
`,
            );

            const viaPackage = await rejectsWith(`import React from 'react';
import { widget } from 'fake-ui';

export default function Board(): React.ReactElement {
    return <div>{String(widget)}</div>;
}
`, root);
            expect(viaPackage.message).toContain('react/jsx-runtime');
            expect(viaPackage.message).toContain('platform modules are imported by name only');

            const direct = await rejectsWith(`import 'react-dom/client';
import React from 'react';

export default function Board(): React.ReactElement {
    return <div />;
}
`, root);
            expect(direct.message).toContain('react-dom/client');
            expect(direct.message).toContain('platform modules are imported by name only');
        } finally {
            remove();
        }
    });

    // Brief row 12.
    it('names a package that is not installed', async () => {
        const { root, remove } = makeProject();
        try {
            const error = await rejectsWith(`import x from 'not-installed-pkg';
import React from 'react';

export default function Board(): React.ReactElement {
    return <div>{String(x)}</div>;
}
`, root);

            expect(error.message).toContain('not-installed-pkg');
        } finally {
            remove();
        }
    });

    // Brief row 13.
    it('refuses computed import() and require() with the file and position', async () => {
        const { root, remove } = makeProject();
        try {
            const dynamicImport = await rejectsWith(`import React from 'react';
const n = 'x';
void import(n);

export default function Board(): React.ReactElement {
    return <div />;
}
`, root);
            // Verified against the real bundler: void import(n); on line 3 reports column 5.
            expect(dynamicImport.message).toBe(`pages/board.tsx:3:5: ${COMPUTED_SPECIFIER}`);

            const dynamicRequire = await rejectsWith(`import React from 'react';
const n = 'x';
void require(n);

export default function Board(): React.ReactElement {
    return <div />;
}
`, root);
            expect(dynamicRequire.message).toBe(`pages/board.tsx:3:5: ${COMPUTED_SPECIFIER}`);
        } finally {
            remove();
        }
    });

    // Fix round 1 (finding 3, manager ruling): the brief's premise was
    // wrong — a '</script>' string in page source is printed escaped by
    // esbuild, so it cannot reach the compiled text; the guard stays for
    // the filename case, where the sequence does reach the output.
    it('keeps script-closing strings in page source out of the compiled output', async () => {
        const { root, remove } = makeProject();
        try {
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';
const s1 = '</script>';
const s2 = \`</script>\`;
const re = /<\\/script>/;

export default function Board(): React.ReactElement {
    return <div>{s1}{s2}{String(re)}</div>;
}
`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            // Positive control: the escaped form is what esbuild prints.
            expect(bundle.compiled).toContain('<\\/script>');
            // The product guard uses this same pattern: no raw
            // script-closing sequence may reach the inlined module.
            expect(bundle.compiled).not.toMatch(/<\/script/i);
        } finally {
            remove();
        }
    });

    // Fix round 1 (finding 3): the guard fires when the literal reaches the
    // output, which happens through a project file whose name contains the
    // sequence (esbuild emits `// <path>` section comments verbatim). `<`
    // and `>` are illegal in Windows file names, so like row 9 this row
    // skips there (unit CI is Linux-only).
    it.skipIf(process.platform === 'win32')('refuses a page whose compiled output contains a script-closing string', async () => {
        const { root, remove } = makeProject();
        try {
            writeFile(root, 'lib/a</script>b.ts', `export const v = 1;\n`);
            const error = await rejectsWith(`import React from 'react';
import { v } from '../lib/a</script>b';

export default function Board(): React.ReactElement {
    return <div>{v}</div>;
}
`, root);

            expect(error.message).toContain('</script');
        } finally {
            remove();
        }
    });

    // Brief row 15. Fixture note: the brief's array-literal fixture cannot
    // reach the compiled cap — a ~3 MB sources tree trips the 1 MiB sources
    // cap first (sources are checked before the compiled text). This row
    // keeps the brief's assertion exactly and builds the source so the
    // compiled cap is the one that fires: 65,000 literal <span>x</span>
    // elements (~975 KB of sources) compile to ~2.6 MB of
    // React.createElement calls.
    it('refuses a page whose compiled module is over 2 MiB', async () => {
        const { root, remove } = makeProject();
        try {
            const cells = '<span>x</span>\n'.repeat(65000);
            const entry = `import React from 'react';

export default function Board(): React.ReactElement {
    return (
        <div>
${cells}        </div>
    );
}
`;

            const error = await rejectsWith(entry, root);

            expect(error.message).toContain('over the 2 MiB (2097152 bytes) limit');
        } finally {
            remove();
        }
    });

    // Brief row 16. Fixture note: sources counts the entry file too, so the
    // brief's 51-lib-file fixture would read "52 project files". Fifty lib
    // files plus the entry is 51 sources, which exercises the brief's exact
    // message.
    it('refuses a page that reads more than 50 project files', async () => {
        const { root, remove } = makeProject();
        try {
            const count = 50;
            const imports = Array.from(
                { length: count },
                (_, n) => `import { v${n} } from '../lib/f${n}';`,
            ).join('\n');
            const uses = Array.from({ length: count }, (_, n) => `v${n}`).join(', ');
            for (let n = 0; n < count; n += 1) {
                writeFile(root, `lib/f${n}.ts`, `export const v${n} = ${n};\n`);
            }
            const error = await rejectsWith(`import React from 'react';
${imports}

export default function Board(): React.ReactElement {
    return <div>{String([${uses}])}</div>;
}
`, root);

            expect(error.message).toContain('51 project files, over the 50 file limit');
        } finally {
            remove();
        }
    });

    // Brief row 17.
    it('refuses a page whose project files total over 1 MiB', async () => {
        const { root, remove } = makeProject();
        try {
            const prefix = 'export const big = \'';
            const suffix = "';\n";
            writeFile(root, 'lib/big.ts', `${prefix}${'x'.repeat(1100000 - prefix.length - suffix.length)}${suffix}`);
            const error = await rejectsWith(`import React from 'react';
import { big } from '../lib/big';

export default function Board(): React.ReactElement {
    return <div>{big.length}</div>;
}
`, root);

            expect(error.message).toContain('over the 1 MiB (1048576 bytes) limit');
        } finally {
            remove();
        }
    });

    // Brief row 18.
    it('returns an empty stylesheet when the page has no CSS', async () => {
        const { root, remove } = makeProject();
        try {
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';

export default function Board(): React.ReactElement {
    return <div />;
}
`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(bundle.compiledCss).toBe('');
        } finally {
            remove();
        }
    });

    // I1: the entry file is captured at compile time; an equal-length edit
    // in the window between compilation and result assembly must not change
    // the published compiled/sources/entrySource snapshot.
    it('keeps the captured snapshot when the entry changes after compilation', async () => {
        const { root, remove } = makeProject();
        try {
            const origEntry = `import React from 'react';\n\nexport const ENTRY_MARK = 'ORIG_ENTRY_AAAA';\n\nexport default function Board(): React.ReactElement {\n    return <div>{ENTRY_MARK}</div>;\n}\n`;
            const rewrittenEntry = origEntry.replace('ORIG_ENTRY_AAAA', 'ORIG_ENTRY_BBBB');
            expect(rewrittenEntry.length).toBe(origEntry.length);
            writeFile(root, 'pages/board.tsx', origEntry);

            const bundle = await bundlePage('pages/board.tsx', root, {
                afterBundle: () => {
                    writeFile(root, 'pages/board.tsx', rewrittenEntry);
                },
            });

            expect(bundle.compiled).toContain('ORIG_ENTRY_AAAA');
            expect(bundle.compiled).not.toContain('ORIG_ENTRY_BBBB');
            expect(bundle.sources['pages/board.tsx']).toBe(origEntry);
            expect(bundle.entrySource).toBe(origEntry);
            expect(fs.readFileSync(path.join(root, 'pages/board.tsx'), 'utf8')).toBe(rewrittenEntry);
        } finally {
            remove();
        }
    });

    // I1: the same snapshot binding holds for a dependency file.
    it('keeps the captured snapshot when a dependency changes after compilation', async () => {
        const { root, remove } = makeProject();
        try {
            const origDep = `export const DEP_MARK = 'ORIG_DEP_AAAA';\n`;
            const rewrittenDep = origDep.replace('ORIG_DEP_AAAA', 'ORIG_DEP_BBBB');
            expect(rewrittenDep.length).toBe(origDep.length);
            const origEntry = `import React from 'react';\nimport { DEP_MARK } from '../lib/x';\n\nexport default function Board(): React.ReactElement {\n    return <div>{DEP_MARK}</div>;\n}\n`;
            writeFile(root, 'lib/x.ts', origDep);
            writeFile(root, 'pages/board.tsx', origEntry);

            const bundle = await bundlePage('pages/board.tsx', root, {
                afterBundle: () => {
                    writeFile(root, 'lib/x.ts', rewrittenDep);
                },
            });

            expect(bundle.compiled).toContain('ORIG_DEP_AAAA');
            expect(bundle.compiled).not.toContain('ORIG_DEP_BBBB');
            expect(bundle.sources['lib/x.ts']).toBe(origDep);
            expect(bundle.entrySource).toBe(origEntry);
            expect(fs.readFileSync(path.join(root, 'lib/x.ts'), 'utf8')).toBe(rewrittenDep);
        } finally {
            remove();
        }
    });

    // I3: esbuild 0.28.2 default-loads .txt with the text loader (one-off
    // probe output is in the fix report), so a project text import bundles
    // with the exact bytes supplied to esbuild, like any captured input.
    it('bundles a project text import with its exact captured text', async () => {
        const { root, remove } = makeProject();
        try {
            const note = 'plain note MARK_TXT_AAAA\n';
            writeFile(root, 'lib/note.txt', note);
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport note from '../lib/note.txt';\n\nexport default function Board(): React.ReactElement {\n    return <div>{String(note)}</div>;\n}\n`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(bundle.compiled).toContain('plain note MARK_TXT_AAAA');
            expect(bundle.sources['lib/note.txt']).toBe(note);
            expect(bundle.sources['pages/board.tsx']).toContain("../lib/note.txt");
        } finally {
            remove();
        }
    });

    // I3: .json is default-loaded by esbuild and was already in the capture
    // map; this row pins project-level JSON coverage for the loader sweep.
    it('bundles a project JSON import with its exact captured text', async () => {
        const { root, remove } = makeProject();
        try {
            const data = '{"label":"MARK_JSON_AAAA"}\n';
            writeFile(root, 'lib/data.json', data);
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport info from '../lib/data.json';\n\nexport default function Board(): React.ReactElement {\n    return <div>{info.label}</div>;\n}\n`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(bundle.compiled).toContain('MARK_JSON_AAAA');
            expect(bundle.sources['lib/data.json']).toBe(data);
        } finally {
            remove();
        }
    });

    // I3: .jsx is default-loaded by esbuild and was already in the capture
    // map; this row pins project-level JSX coverage for the loader sweep.
    // Real JSX syntax (not plain JS) so the row fails if the capture ever
    // hands esbuild another loader for the file.
    it('bundles a project JSX import with its exact captured text', async () => {
        const { root, remove } = makeProject();
        try {
            const badge = `import React from 'react';\n\nexport function Badge() {\n    return <span>MARK_JSX_AAAA</span>;\n}\n`;
            writeFile(root, 'lib/badge.jsx', badge);
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport { Badge } from '../lib/badge.jsx';\n\nexport default function Board(): React.ReactElement {\n    return <div><Badge /></div>;\n}\n`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(bundle.compiled).toContain('MARK_JSX_AAAA');
            expect(bundle.sources['lib/badge.jsx']).toBe(badge);
        } finally {
            remove();
        }
    });

    // I3: .mjs is default-loaded by esbuild as ESM and shares the js
    // capture loader; the named export pins real module behavior.
    it('bundles a project mjs import with its exact captured text', async () => {
        const { root, remove } = makeProject();
        try {
            const mod = `export const MOD_MARK = 'MARK_MJS_AAAA';\n`;
            writeFile(root, 'lib/mod.mjs', mod);
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport { MOD_MARK } from '../lib/mod.mjs';\n\nexport default function Board(): React.ReactElement {\n    return <div>{MOD_MARK}</div>;\n}\n`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(bundle.compiled).toContain('MARK_MJS_AAAA');
            expect(bundle.sources['lib/mod.mjs']).toBe(mod);
        } finally {
            remove();
        }
    });

    // I3: .cjs is default-loaded by esbuild as CommonJS and shares the js
    // capture loader; the default import of module.exports pins the
    // interop the mapping preserves.
    it('bundles a project cjs import with its exact captured text', async () => {
        const { root, remove } = makeProject();
        try {
            const leg = `module.exports = 'MARK_CJS_AAAA';\n`;
            writeFile(root, 'lib/leg.cjs', leg);
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport leg from '../lib/leg.cjs';\n\nexport default function Board(): React.ReactElement {\n    return <div>{String(leg)}</div>;\n}\n`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(bundle.compiled).toContain('MARK_CJS_AAAA');
            expect(bundle.sources['lib/leg.cjs']).toBe(leg);
        } finally {
            remove();
        }
    });

    // I3: .mts is default-loaded by esbuild as TypeScript and shares the ts
    // capture loader; the annotation pins that the ts loader ran.
    it('bundles a project mts import with its exact captured text', async () => {
        const { root, remove } = makeProject();
        try {
            const mod = `export const MOD_MARK: string = 'MARK_MTS_AAAA';\n`;
            writeFile(root, 'lib/mod.mts', mod);
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport { MOD_MARK } from '../lib/mod.mts';\n\nexport default function Board(): React.ReactElement {\n    return <div>{MOD_MARK}</div>;\n}\n`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(bundle.compiled).toContain('MARK_MTS_AAAA');
            expect(bundle.sources['lib/mod.mts']).toBe(mod);
        } finally {
            remove();
        }
    });

    // I3: .cts is default-loaded by esbuild as TypeScript and shares the ts
    // capture loader; the annotation pins that the ts loader ran.
    it('bundles a project cts import with its exact captured text', async () => {
        const { root, remove } = makeProject();
        try {
            const mod = `export const MOD_MARK: string = 'MARK_CTS_AAAA';\n`;
            writeFile(root, 'lib/mod.cts', mod);
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport { MOD_MARK } from '../lib/mod.cts';\n\nexport default function Board(): React.ReactElement {\n    return <div>{MOD_MARK}</div>;\n}\n`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(bundle.compiled).toContain('MARK_CTS_AAAA');
            expect(bundle.sources['lib/mod.cts']).toBe(mod);
        } finally {
            remove();
        }
    });

    // I1: *.module.css keeps esbuild's default local-css behavior through the
    // capture plugin (scoped class names, e.g. `.box` in m.module.css becomes
    // `.m_box` — the same output esbuild produces without the plugin).
    it('bundles a module stylesheet with scoped class names', async () => {
        const { root, remove } = makeProject();
        try {
            writeFile(root, 'lib/m.module.css', '.box{color:red}\n');
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport '../lib/m.module.css';\n\nexport default function Board(): React.ReactElement {\n    return <div />;\n}\n`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(bundle.compiledCss).toContain('.m_box');
            expect(bundle.compiledCss).toMatch(/color:\s*red/);
            expect(bundle.sources['lib/m.module.css']).toBe('.box{color:red}\n');
        } finally {
            remove();
        }
    });

    // I1 family guard (PM ruling): an entry plus three dependencies with
    // distinct text and distinct compiled markers. After compilation, EVERY
    // captured project file is, in separate sub-cases, (a) replaced by a
    // symlink to a DIFFERENT captured file, (b) replaced by a symlink to an
    // outside-root file holding a secret marker, and (c) rewritten with
    // different bytes of equal and of different length. Every sub-case must
    // return exactly the pre-hook bundle; the secret marker appears in
    // nothing returned. Skips on win32 (symlink privileges), like row 9.
    it.skipIf(process.platform === 'win32')('keeps the exact pre-hook snapshot when any captured file is replaced after compilation', async () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            const depA = `export const MARK_A = 'DEP_A_AAAA';\n`;
            const depB = `export const MARK_B = 'DEP_B_BBBB';\n`;
            const depC = `export const MARK_C = 'DEP_C_CCCC';\n`;
            const entry = `import React from 'react';\nimport { MARK_A } from '../lib/a';\nimport { MARK_B } from '../lib/b';\nimport { MARK_C } from '../lib/c';\n\nexport const ENTRY_MARK = 'ENTRY_EEEE';\n\nexport default function Board(): React.ReactElement {\n    return <div>{MARK_A}{MARK_B}{MARK_C}{ENTRY_MARK}</div>;\n}\n`;
            const originals: Record<string, string> = {
                'pages/board.tsx': entry,
                'lib/a.ts': depA,
                'lib/b.ts': depB,
                'lib/c.ts': depC,
            };
            writeFile(root, 'lib/a.ts', depA);
            writeFile(root, 'lib/b.ts', depB);
            writeFile(root, 'lib/c.ts', depC);
            writeFile(root, 'pages/board.tsx', entry);

            const baseline = await bundlePage('pages/board.tsx', root);
            for (const [rel, text] of Object.entries(originals)) {
                expect(baseline.sources[rel]).toBe(text);
            }
            expect(baseline.entrySource).toBe(entry);
            for (const marker of ['DEP_A_AAAA', 'DEP_B_BBBB', 'DEP_C_CCCC', 'ENTRY_EEEE']) {
                expect(baseline.compiled).toContain(marker);
            }

            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.writeFileSync(path.join(outside, 'secret.ts'), `export const SECRET_MARKER_FAMILY_GUARD = 'shhh';\n`);

            const targets = ['pages/board.tsx', 'lib/a.ts', 'lib/b.ts', 'lib/c.ts'];
            // A permutation onto a different captured file: entry->a, a->b,
            // b->c, c->entry.
            const peer: Record<string, string> = {
                'pages/board.tsx': 'lib/a.ts',
                'lib/a.ts': 'lib/b.ts',
                'lib/b.ts': 'lib/c.ts',
                'lib/c.ts': 'pages/board.tsx',
            };
            const restore = (rel: string): void => {
                const full = path.join(root, rel);
                try {
                    if (fs.lstatSync(full).isSymbolicLink()) {
                        fs.unlinkSync(full);
                    }
                } catch {
                    // Missing below: recreated by the write.
                }
                fs.writeFileSync(full, originals[rel]);
            };
            const runWith = async (target: string, mutate: () => void): Promise<Awaited<ReturnType<typeof bundlePage>>> => {
                try {
                    return await bundlePage('pages/board.tsx', root, { afterBundle: mutate });
                } finally {
                    restore(target);
                }
            };
            const expectUnchanged = (bundle: Awaited<ReturnType<typeof bundlePage>>): void => {
                expect(bundle.sources).toEqual(baseline.sources);
                expect(bundle.entrySource).toBe(baseline.entrySource);
                expect(bundle.compiled).toBe(baseline.compiled);
                expect(JSON.stringify(bundle)).not.toContain('SECRET_MARKER_FAMILY_GUARD');
                expect(bundle.compiled).not.toContain('shhh');
            };

            for (const target of targets) {
                // (a) symlink to a different captured file.
                await expectUnchanged(
                    await runWith(target, () => {
                        fs.rmSync(path.join(root, target), { force: true });
                        fs.symlinkSync(path.join(root, peer[target]), path.join(root, target));
                    }),
                );
                // (b) symlink to an outside-root file holding a secret marker.
                await expectUnchanged(
                    await runWith(target, () => {
                        fs.rmSync(path.join(root, target), { force: true });
                        fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, target));
                    }),
                );
                // (c) rewritten with different bytes, first of equal length.
                const sameLength = `${originals[target].slice(0, -2)}Z\n`;
                expect(sameLength.length).toBe(originals[target].length);
                expect(sameLength).not.toBe(originals[target]);
                await expectUnchanged(
                    await runWith(target, () => {
                        fs.writeFileSync(path.join(root, target), sameLength);
                    }),
                );
                // (c) then of different length.
                await expectUnchanged(
                    await runWith(target, () => {
                        fs.writeFileSync(path.join(root, target), `${originals[target]}// extra\n`);
                    }),
                );
            }
            // The fixture is restored file by file; the tree matches the start.
            for (const [rel, text] of Object.entries(originals)) {
                expect(fs.readFileSync(path.join(root, rel), 'utf8')).toBe(text);
            }
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // I1 hard rule: an entry that is a symlink to a file outside the real
    // root is refused before the file is read — PageBundleError names the
    // path, and the outside marker is in no message or result. Skips on
    // win32, like row 9.
    it.skipIf(process.platform === 'win32')('refuses an entry symlink to an outside text file before reading it', async () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.writeFileSync(
                path.join(outside, 'x.ts'),
                `export const SECRET_MARKER_ENTRY_OUTSIDE = 'shhh';\nexport default function Outside(): string {\n    return SECRET_MARKER_ENTRY_OUTSIDE;\n}\n`,
            );
            fs.mkdirSync(path.join(root, 'proj', 'pages'), { recursive: true });
            fs.symlinkSync(path.join(outside, 'x.ts'), path.join(root, 'proj', 'pages', 'board.tsx'));

            const error = await bundlePage('pages/board.tsx', `${root}/proj`).then(
                () => null,
                (cause: unknown) => cause,
            );

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('outside the project directory');
            expect((error as PageBundleError).message).toContain(path.basename(outside));
            expect((error as PageBundleError).message).not.toContain('SECRET_MARKER_ENTRY_OUTSIDE');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // I1 hard rule: a dependency that is a symlink to a file outside the
    // real root is refused before the file is read. Skips on win32, like
    // row 9.
    it.skipIf(process.platform === 'win32')('refuses a dependency symlink to an outside file before reading it', async () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.writeFileSync(path.join(outside, 'x.ts'), `export const SECRET_MARKER_DEP_OUTSIDE = 'shhh';\n`);
            fs.mkdirSync(path.join(root, 'proj', 'pages'), { recursive: true });
            fs.mkdirSync(path.join(root, 'proj', 'lib'), { recursive: true });
            fs.symlinkSync(path.join(outside, 'x.ts'), path.join(root, 'proj', 'lib', 'x.ts'));
            writeFile(
                `${root}/proj`,
                'pages/board.tsx',
                `import React from 'react';\nimport '../lib/x';\n\nexport default function Board(): React.ReactElement {\n    return <div />;\n}\n`,
            );

            const error = await bundlePage('pages/board.tsx', `${root}/proj`).then(
                () => null,
                (cause: unknown) => cause,
            );

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('outside the project directory');
            expect((error as PageBundleError).message).toContain(path.basename(outside));
            expect((error as PageBundleError).message).not.toContain('SECRET_MARKER_DEP_OUTSIDE');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // I1 hard rule, follow-on 2b: a project dependency that is a symlink to
    // an outside file under an OUTSIDE node_modules directory is refused
    // before the file is read. The real path's node_modules component must
    // not exempt it from containment. Skips on win32, like row 9.
    it.skipIf(process.platform === 'win32')('refuses a dependency symlink to an outside file under node_modules', async () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.mkdirSync(path.join(outside, 'node_modules', 'leak'), { recursive: true });
            fs.writeFileSync(
                path.join(outside, 'node_modules', 'leak', 'index.ts'),
                `export const LEAK_MARKER_NODE_MODULES_BYPASS = 'shhh';\n`,
            );
            fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
            fs.symlinkSync(path.join(outside, 'node_modules', 'leak', 'index.ts'), path.join(root, 'lib', 'dep.ts'));
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport { LEAK_MARKER_NODE_MODULES_BYPASS } from '../lib/dep';\n\nexport default function Board(): React.ReactElement {\n    return <div>{LEAK_MARKER_NODE_MODULES_BYPASS}</div>;\n}\n`,
            );

            const error = await bundlePage('pages/board.tsx', root).then(
                () => null,
                (cause: unknown) => cause,
            );

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('outside the project directory');
            expect((error as PageBundleError).message).toContain(path.basename(outside));
            expect((error as PageBundleError).message).not.toContain('LEAK_MARKER_NODE_MODULES_BYPASS');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // I1 hard rule, follow-on 2b: an in-root node_modules package that is a
    // symlink to a hoisted (outside-root) node_modules package is refused
    // the same way — hoisted/workspace packages resolving above the project
    // root are not legitimate in-root dependencies. Skips on win32.
    it.skipIf(process.platform === 'win32')('refuses an in-root package symlink to a hoisted outside package', async () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.mkdirSync(path.join(outside, 'node_modules', 'real-pkg'), { recursive: true });
            fs.writeFileSync(
                path.join(outside, 'node_modules', 'real-pkg', 'package.json'),
                '{"name":"real-pkg","version":"1.0.0","main":"index.js"}',
            );
            fs.writeFileSync(
                path.join(outside, 'node_modules', 'real-pkg', 'index.js'),
                `export const HOIST_MARKER_OUTSIDE_PKG = 'shhh';\n`,
            );
            fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
            fs.symlinkSync(path.join(outside, 'node_modules', 'real-pkg'), path.join(root, 'node_modules', 'pkg'));
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport { HOIST_MARKER_OUTSIDE_PKG } from 'pkg';\n\nexport default function Board(): React.ReactElement {\n    return <div>{HOIST_MARKER_OUTSIDE_PKG}</div>;\n}\n`,
            );

            const error = await bundlePage('pages/board.tsx', root).then(
                () => null,
                (cause: unknown) => cause,
            );

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('outside the project directory');
            expect((error as PageBundleError).message).toContain('real-pkg');
            expect((error as PageBundleError).message).not.toContain('HOIST_MARKER_OUTSIDE_PKG');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // 2c: an absolute metafile input key is never skipped as node_modules.
    // Absolute-but-outside is the outside refusal; absolute-but-inside is
    // refused as an unexpected absolute path. Pure data through the
    // exported assembly function — no files, no symlinks.
    it('refuses absolute metafile input paths in source assembly', () => {
        const realRoot = '/proj';
        const entryKey = 'pages/board.tsx';
        const entryAbs = '/proj/pages/board.tsx';
        const entryText = `import React from 'react';\n\nexport default function Board(): React.ReactElement {\n    return <div />;\n}\n`;
        const entryInput = { 'pages/board.tsx': { format: 'esm' } };
        const captured = new Map([[entryAbs, entryText]]);

        // (a) absolute in-root node_modules key: never skipped, refused.
        // Class AND message: an ordinary Error with this text must not pass.
        let absoluteInRootError: unknown = null;
        try {
            assembleSources(
                captured,
                { inputs: { ...entryInput, '/proj/node_modules/pkg/index.js': { format: 'esm' } } },
                realRoot,
                entryKey,
            );
        } catch (error) {
            absoluteInRootError = error;
        }
        expect(absoluteInRootError).toBeInstanceOf(PageBundleError);
        expect((absoluteInRootError as PageBundleError).message).toContain(
            '/proj/node_modules/pkg/index.js: unexpected absolute input path',
        );

        // (b) absolute outside key: the outside refusal.
        // Class AND message: an ordinary Error with this text must not pass.
        let absoluteOutsideError: unknown = null;
        try {
            assembleSources(
                captured,
                { inputs: { ...entryInput, '/other/x.ts': { format: 'esm' } } },
                realRoot,
                entryKey,
            );
        } catch (error) {
            absoluteOutsideError = error;
        }
        expect(absoluteOutsideError).toBeInstanceOf(PageBundleError);
        expect((absoluteOutsideError as PageBundleError).message).toContain(
            '/other/x.ts: imported from outside the project directory',
        );

        // Control: a relative node_modules key is still skipped and a
        // relative project key is still assembled.
        const withRelative = assembleSources(
            new Map([
                [entryAbs, entryText],
                ['/proj/lib/x.ts', `export const x = 1;\n`],
            ]),
            {
                inputs: {
                    ...entryInput,
                    'node_modules/pkg/index.js': { format: 'esm' },
                    'lib/x.ts': { format: 'esm' },
                },
            },
            realRoot,
            entryKey,
        );
        expect(withRelative.sources).toEqual({
            'pages/board.tsx': entryText,
            'lib/x.ts': `export const x = 1;\n`,
        });
        expect(withRelative.entrySource).toBe(entryText);
    });

    // I1 structural guard for the PM's "assembly is pure" rule: the
    // assembly section must be a pure function of (captured map, metafile)
    // with no filesystem call, so a future edit cannot reintroduce a live
    // lookup without failing here. The body is extracted by a string-aware
    // brace match (a naive count stops at the first `${...}` interpolation
    // and would pass vacuously); the marker pins below prove the extraction
    // reached the real end of the function.
    it('keeps source assembly free of filesystem calls', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/utils/page-bundle.ts'), 'utf8');

        expect(src).toContain('function assembleSources');
        const start = src.indexOf('function assembleSources');
        // The parameter list holds no parens of its own, so the first `)`
        // closes it; the first balanced `{...}` unit after that is either
        // the object return-type annotation (followed by the body `{`) or,
        // with a plain return type, the body itself.
        const closeParen = src.indexOf(')', src.indexOf('(', start));
        expect(closeParen).toBeGreaterThan(start);
        const firstOpen = src.indexOf('{', closeParen);
        expect(firstOpen).toBeGreaterThan(closeParen);
        const firstClose = matchBraces(src, firstOpen);
        expect(firstClose).toBeGreaterThan(firstOpen);
        let open = firstOpen;
        let end = firstClose;
        const afterFirst = src.slice(firstClose + 1).match(/^\s*\{/);
        if (afterFirst !== null) {
            open = firstClose + 1 + (afterFirst[0].length - 1);
            end = matchBraces(src, open);
        }
        expect(end).toBeGreaterThan(open);
        const body = src.slice(open, end);
        // Extraction reached the real end: the caps and the entry return
        // live at the bottom of the function.
        expect(body).toContain('SOURCES_MAX_FILES');
        expect(body).toContain('entrySource');
        for (const token of ['realpath', 'readFileSync', 'statSync', 'lstat', 'existsSync', 'fs.', 'await']) {
            expect(body).not.toContain(token);
        }
    });

    // C1 redesign, READ-BOUNDARY SWAP TO OUTSIDE (direct): the hook runs
    // between the containment check and the open; replacing the admitted
    // in-root file with a symlink to an outside file must refuse, and the
    // outside marker appears in nothing thrown or returned. Skips on win32.
    it.skipIf(process.platform === 'win32')('readAdmitted refuses a file swapped for an outside symlink at the read boundary', () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            const realRoot = fs.realpathSync(root);
            const admitted = path.join(root, 'lib', 'a.ts');
            writeFile(root, 'lib/a.ts', `export const A = 'DEP_A_AAAA';\n`);
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.writeFileSync(path.join(outside, 'secret.ts'), `export const SECRET_MARKER_READ_BOUNDARY_OUTSIDE = 'shhh';\n`);

            let error: unknown = null;
            try {
                readAdmitted(admitted, realRoot, {
                    beforeOpen: () => {
                        fs.rmSync(admitted, { force: true });
                        fs.symlinkSync(path.join(outside, 'secret.ts'), admitted);
                    },
                });
            } catch (cause) {
                error = cause;
            }

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).not.toContain('SECRET_MARKER_READ_BOUNDARY_OUTSIDE');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // C1 redesign, READ-BOUNDARY SWAP TO ANOTHER IN-ROOT FILE (direct,
    // symlink variant): the admitted file becomes a symlink to a different
    // in-root file inside the window; the open handle cannot match the
    // admitted identity, so the read refuses. Skips on win32.
    it.skipIf(process.platform === 'win32')('readAdmitted refuses a file swapped for another in-root file at the read boundary', () => {
        const { root, remove } = makeProject();
        try {
            const realRoot = fs.realpathSync(root);
            const admitted = path.join(root, 'lib', 'a.ts');
            writeFile(root, 'lib/a.ts', `export const A = 'DEP_A_AAAA';\n`);
            writeFile(root, 'lib/b.ts', `export const B = 'DEP_B_BBBB_DIFFERENT';\n`);

            let error: unknown = null;
            try {
                readAdmitted(admitted, realRoot, {
                    beforeOpen: () => {
                        fs.rmSync(admitted, { force: true });
                        fs.symlinkSync(path.join(root, 'lib', 'b.ts'), admitted);
                    },
                });
            } catch (cause) {
                error = cause;
            }

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('changed while it was being read');
        } finally {
            remove();
        }
    });

    // C1 redesign, READ-BOUNDARY SWAP TO OUTSIDE VIA DIRECTORY (direct):
    // the hook swaps an intermediate directory for a symlink to an outside
    // directory holding a same-named file, in the window between the
    // containment check and the pre-open stat. The open handle's kernel
    // path is outside, so the read refuses naming the requested path and
    // the marker is in nothing thrown. Needs /proc: skips on win32 and
    // where the kernel paths are unavailable (the twin row below pins the
    // fallback there).
    it.skipIf(!HAS_PROC || process.platform === 'win32')('readAdmitted refuses a file whose directory was swapped for an outside directory at the read boundary', () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            const realRoot = fs.realpathSync(root);
            const admitted = path.join(root, 'lib', 'dep.ts');
            writeFile(root, 'lib/dep.ts', `export const DEP_MARK = 'DEP_OK_AAAA';\n`);
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.mkdirSync(path.join(outside, 'lib'), { recursive: true });
            fs.writeFileSync(path.join(outside, 'lib', 'dep.ts'), `export const SECRET_MARKER_DIR_SWAP_OUTSIDE = 'shhh';\n`);

            let error: unknown = null;
            try {
                readAdmitted(admitted, realRoot, {
                    beforeStat: () => {
                        fs.renameSync(path.join(root, 'lib'), path.join(root, 'lib-orig'));
                        fs.symlinkSync(path.join(outside, 'lib'), path.join(root, 'lib'));
                    },
                });
            } catch (cause) {
                error = cause;
            }

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('outside the project directory');
            expect((error as PageBundleError).message).not.toContain('SECRET_MARKER_DIR_SWAP_OUTSIDE');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // Fallback twin of the row above for platforms without /proc: the same
    // directory swap is caught by the post-open realpath re-check instead,
    // so the refusal names the requested path but reports a changed read.
    // Runs only where the kernel paths are unavailable (and not on win32).
    it.skipIf(HAS_PROC || process.platform === 'win32')('readAdmitted refuses a swapped directory through the fallback check where /proc is unavailable', () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            const realRoot = fs.realpathSync(root);
            const admitted = path.join(root, 'lib', 'dep.ts');
            writeFile(root, 'lib/dep.ts', `export const DEP_MARK = 'DEP_OK_AAAA';\n`);
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.mkdirSync(path.join(outside, 'lib'), { recursive: true });
            fs.writeFileSync(path.join(outside, 'lib', 'dep.ts'), `export const SECRET_MARKER_DIR_SWAP_FALLBACK = 'shhh';\n`);

            let error: unknown = null;
            try {
                readAdmitted(admitted, realRoot, {
                    beforeStat: () => {
                        fs.renameSync(path.join(root, 'lib'), path.join(root, 'lib-orig'));
                        fs.symlinkSync(path.join(outside, 'lib'), path.join(root, 'lib'));
                    },
                });
            } catch (cause) {
                error = cause;
            }

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('changed while it was being read');
            expect((error as PageBundleError).message).not.toContain('SECRET_MARKER_DIR_SWAP_FALLBACK');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // C1 redesign, INODE row (before-open window): the replacement has
    // EXACTLY the same size (asserted), so only the dev/ino comparison of
    // the open handle against the pre-open stat can tell them apart. The
    // hook swaps between the pre-open stat and the open. No symlink: runs
    // on every platform.
    it('readAdmitted refuses a file replaced by rename at the read boundary and reads through a no-op hook', () => {
        const { root, remove } = makeProject();
        try {
            const realRoot = fs.realpathSync(root);
            const admitted = path.join(root, 'lib', 'a.ts');
            const orig = `export const A = 'DEP_A_AAAA';\n`;
            const replacement = `export const A = 'DEP_A_BBBB';\n`;
            expect(replacement.length).toBe(orig.length);
            writeFile(root, 'lib/a.ts', orig);
            writeFile(root, 'lib/c.ts', replacement);

            let error: unknown = null;
            try {
                readAdmitted(admitted, realRoot, {
                    beforeOpen: () => {
                        fs.renameSync(path.join(root, 'lib', 'c.ts'), admitted);
                    },
                });
            } catch (cause) {
                error = cause;
            }

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('changed while it was being read');

            // Unchanged control: the hook runs but touches nothing.
            writeFile(root, 'lib/a.ts', orig);
            expect(readAdmitted(admitted, realRoot, { beforeOpen: () => {} })).toBe(orig);
            expect(readAdmitted(admitted, realRoot)).toBe(orig);
        } finally {
            remove();
        }
    });

    // C1 redesign, INODE row (after-open window): the same same-sized
    // replacement, swapped after the open, is caught by the post-open
    // comparison instead — dev/ino still the only tell (size is equal,
    // the path resolves identically). No symlink: runs on every platform.
    it('readAdmitted refuses a same-sized replacement swapped after the open', () => {
        const { root, remove } = makeProject();
        try {
            const realRoot = fs.realpathSync(root);
            const admitted = path.join(root, 'lib', 'a.ts');
            const orig = `export const A = 'DEP_A_AAAA';\n`;
            const replacement = `export const A = 'DEP_A_BBBB';\n`;
            expect(replacement.length).toBe(orig.length);
            writeFile(root, 'lib/a.ts', orig);
            writeFile(root, 'lib/c.ts', replacement);

            let error: unknown = null;
            try {
                readAdmitted(admitted, realRoot, {
                    afterOpen: () => {
                        fs.renameSync(path.join(root, 'lib', 'c.ts'), admitted);
                    },
                });
            } catch (cause) {
                error = cause;
            }

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('changed while it was being read');
        } finally {
            remove();
        }
    });

    // C1 redesign step (c): the admitted path must be a regular file.
    // No symlink: runs on every platform.
    it('readAdmitted refuses a directory as not a regular file', () => {
        const { root, remove } = makeProject();
        try {
            const realRoot = fs.realpathSync(root);
            fs.mkdirSync(path.join(root, 'lib'), { recursive: true });

            let error: unknown = null;
            try {
                readAdmitted(path.join(root, 'lib'), realRoot);
            } catch (cause) {
                error = cause;
            }

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('not a regular file');
        } finally {
            remove();
        }
    });

    // C1 redesign, O_NOFOLLOW row: the hook swaps the admitted file for a
    // symlink to a HARD LINK of the same inode (asserted: same dev, ino
    // and size), so no identity comparison can tell them apart and only the
    // O_NOFOLLOW open refuses it. Skips on win32.
    it.skipIf(process.platform === 'win32')('readAdmitted refuses a file swapped for a symlink to a hard link of the same inode', () => {
        const { root, remove } = makeProject();
        try {
            const realRoot = fs.realpathSync(root);
            const admitted = path.join(root, 'lib', 'a.ts');
            const orig = `export const A = 'DEP_A_AAAA';\n`;
            writeFile(root, 'lib/a.ts', orig);
            const hard = path.join(root, 'lib', 'hard.ts');
            fs.linkSync(admitted, hard);
            const before = fs.statSync(admitted);
            const hardStat = fs.statSync(hard);
            expect(hardStat.dev).toBe(before.dev);
            expect(hardStat.ino).toBe(before.ino);
            expect(hardStat.size).toBe(before.size);

            let error: unknown = null;
            try {
                readAdmitted(admitted, realRoot, {
                    beforeOpen: () => {
                        fs.rmSync(admitted, { force: true });
                        fs.symlinkSync(hard, admitted);
                    },
                });
            } catch (cause) {
                error = cause;
            }

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('changed while it was being read');
        } finally {
            remove();
        }
    });

    // C1 redesign, SIZE rows: the hook rewrites the admitted file in place
    // (same dev+ino, asserted) with a different length, so only the size
    // comparison can tell. One variant per window (before-open compares
    // against the pre-open stat, after-open against the post-open stat).
    // No symlink or rename: runs on every platform.
    for (const window of ['beforeOpen', 'afterOpen'] as const) {
        it(`readAdmitted refuses an in-place rewrite with a different length at ${window}`, () => {
            const { root, remove } = makeProject();
            try {
                const realRoot = fs.realpathSync(root);
                const admitted = path.join(root, 'lib', 'a.ts');
                const orig = `export const A = 'DEP_A_AAAA';\n`;
                writeFile(root, 'lib/a.ts', orig);
                const before = fs.statSync(admitted);

                let error: unknown = null;
                try {
                    readAdmitted(admitted, realRoot, {
                        [window]: () => {
                            fs.writeFileSync(admitted, `${orig}// extra line so the size differs\n`);
                        },
                    });
                } catch (cause) {
                    error = cause;
                }

                expect(fs.statSync(admitted).ino).toBe(before.ino);
                expect(error).toBeInstanceOf(PageBundleError);
                expect((error as PageBundleError).message).toContain('changed while it was being read');
            } finally {
                remove();
            }
        });
    }

    // C1 redesign, READ-BOUNDARY SWAP TO OUTSIDE through a real bundle: the
    // hook swaps a dependency for an outside symlink inside its own read
    // window (the hook names the admitted path, so only that file moves).
    // The build refuses before publication and the marker is in no message.
    // Skips on win32.
    it.skipIf(process.platform === 'win32')('refuses a dependency swapped for an outside file at the read boundary', async () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.writeFileSync(path.join(outside, 'secret.ts'), `export const SECRET_MARKER_DEP_READ_BOUNDARY = 'shhh';\n`);
            writeFile(root, 'lib/dep.ts', `export const DEP_MARK = 'DEP_OK_AAAA';\n`);
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport { DEP_MARK } from '../lib/dep';\n\nexport default function Board(): React.ReactElement {\n    return <div>{DEP_MARK}</div>;\n}\n`,
            );
            const dep = path.join(root, 'lib', 'dep.ts');

            const error = await bundlePage('pages/board.tsx', root, {
                beforeOpen: (admittedPath) => {
                    if (admittedPath === dep) {
                        fs.rmSync(admittedPath, { force: true });
                        fs.symlinkSync(path.join(outside, 'secret.ts'), admittedPath);
                    }
                },
            }).then(
                () => null,
                (cause: unknown) => cause,
            );

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('changed while it was being read');
            expect((error as PageBundleError).message).not.toContain('SECRET_MARKER_DEP_READ_BOUNDARY');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // C1 redesign, READ-BOUNDARY SWAP TO ANOTHER IN-ROOT FILE through a real
    // bundle, one variant per window: a different file renamed over the
    // dependency between the pre-open stat and the open (beforeOpen, caught
    // by the pre-open identity) or after the open (afterOpen, caught by the
    // post-open comparison). The targeted hook leaves the entry's own reads
    // untouched. No symlink: runs on every platform.
    for (const window of ['beforeOpen', 'afterOpen'] as const) {
        it(`refuses a dependency replaced by rename at the read boundary (${window})`, async () => {
            const { root, remove } = makeProject();
            try {
                writeFile(root, 'lib/dep.ts', `export const DEP_MARK = 'DEP_OK_AAAA';\n`);
                writeFile(root, 'lib/other.ts', `export const OTHER_MARK = 'DEP_REPLACEMENT_BBBB_LONGER';\n`);
                writeFile(
                    root,
                    'pages/board.tsx',
                    `import React from 'react';\nimport { DEP_MARK } from '../lib/dep';\n\nexport default function Board(): React.ReactElement {\n    return <div>{DEP_MARK}</div>;\n}\n`,
                );
                const dep = path.join(root, 'lib', 'dep.ts');

                const error = await bundlePage('pages/board.tsx', root, {
                    [window]: (admittedPath: string) => {
                        if (admittedPath === dep) {
                            fs.renameSync(path.join(root, 'lib', 'other.ts'), admittedPath);
                        }
                    },
                }).then(
                    () => null,
                    (cause: unknown) => cause,
                );

                expect(error).toBeInstanceOf(PageBundleError);
                expect((error as PageBundleError).message).toContain('changed while it was being read');
            } finally {
                remove();
            }
        });
    }

    // C1 redesign, READ-BOUNDARY SWAP TO OUTSIDE VIA DIRECTORY through a
    // real bundle: the hook swaps the dependency's intermediate directory
    // for a symlink to an outside directory between the containment check
    // and the pre-open stat. The open handle's kernel path is outside, so
    // the build refuses before publication and the marker is in no
    // message. Needs /proc: skips on win32 and where the kernel paths are
    // unavailable (the twin row below pins the fallback there).
    it.skipIf(!HAS_PROC || process.platform === 'win32')('refuses a dependency whose directory was swapped for an outside directory at the read boundary', async () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.mkdirSync(path.join(outside, 'lib'), { recursive: true });
            fs.writeFileSync(path.join(outside, 'lib', 'dep.ts'), `export const SECRET_MARKER_DEP_DIR_SWAP = 'shhh';\n`);
            writeFile(root, 'lib/dep.ts', `export const DEP_MARK = 'DEP_OK_AAAA';\n`);
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport { DEP_MARK } from '../lib/dep';\n\nexport default function Board(): React.ReactElement {\n    return <div>{DEP_MARK}</div>;\n}\n`,
            );
            const dep = path.join(root, 'lib', 'dep.ts');

            const error = await bundlePage('pages/board.tsx', root, {
                beforeStat: (admittedPath) => {
                    if (admittedPath === dep) {
                        fs.renameSync(path.join(root, 'lib'), path.join(root, 'lib-orig'));
                        fs.symlinkSync(path.join(outside, 'lib'), path.join(root, 'lib'));
                    }
                },
            }).then(
                () => null,
                (cause: unknown) => cause,
            );

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('outside the project directory');
            expect((error as PageBundleError).message).not.toContain('SECRET_MARKER_DEP_DIR_SWAP');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // Fallback twin of the row above for platforms without /proc: the same
    // directory swap is caught by the post-open realpath re-check instead.
    // Runs only where the kernel paths are unavailable (and not on win32).
    it.skipIf(HAS_PROC || process.platform === 'win32')('refuses a swapped dependency directory through the fallback check where /proc is unavailable', async () => {
        const { root, remove } = makeProject();
        let outside = '';
        try {
            outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-')));
            fs.mkdirSync(path.join(outside, 'lib'), { recursive: true });
            fs.writeFileSync(path.join(outside, 'lib', 'dep.ts'), `export const SECRET_MARKER_DEP_DIR_FALLBACK = 'shhh';\n`);
            writeFile(root, 'lib/dep.ts', `export const DEP_MARK = 'DEP_OK_AAAA';\n`);
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport { DEP_MARK } from '../lib/dep';\n\nexport default function Board(): React.ReactElement {\n    return <div>{DEP_MARK}</div>;\n}\n`,
            );
            const dep = path.join(root, 'lib', 'dep.ts');

            const error = await bundlePage('pages/board.tsx', root, {
                beforeStat: (admittedPath) => {
                    if (admittedPath === dep) {
                        fs.renameSync(path.join(root, 'lib'), path.join(root, 'lib-orig'));
                        fs.symlinkSync(path.join(outside, 'lib'), path.join(root, 'lib'));
                    }
                },
            }).then(
                () => null,
                (cause: unknown) => cause,
            );

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('changed while it was being read');
            expect((error as PageBundleError).message).not.toContain('SECRET_MARKER_DEP_DIR_FALLBACK');
        } finally {
            remove();
            if (outside !== '') {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        }
    });

    // C1 redesign, ESBUILD NEVER READS DISK ITSELF: the plugin reports
    // every file-namespace path it hands contents for (onLoaded, with the
    // exact string handed over), and the build reports esbuild's own
    // metafile inputs (onMetafile). The loaded set must equal EXACTLY the
    // metafile's non-platform, non-stdin inputs in both directions: a
    // package file admitted but handed back to esbuild (a null return)
    // would appear in the metafile without a loaded path and fail here.
    // Non-vacuity is pinned first (on the base the seams are ignored, so
    // both collections would be empty and a bare equality would pass).
    // (This supersedes the round-4 afterCheck counter row, which counted
    // reads rather than successful returns.)
    it('loads exactly the files esbuild reports, nothing it reads itself', async () => {
        const { root, remove } = makeProject();
        try {
            writeRow1Project(root);
            const loaded = new Map<string, string>();
            let inputs: Record<string, unknown> = {};
            let admissions = 0;

            const bundle = await bundlePage('pages/board.tsx', root, {
                beforeStat: () => {
                    admissions += 1;
                },
                onLoaded: (absPath, contents) => {
                    loaded.set(toPosixPath(path.relative(root, absPath)), contents);
                },
                onMetafile: (metafile) => {
                    inputs = { ...metafile.inputs };
                },
            });

            // Non-vacuity: the seams fired and saw the whole fixture.
            expect(admissions).toBeGreaterThan(0);
            expect(Object.keys(inputs).length).toBeGreaterThan(0);
            expect(admissions).toBe(loaded.size);
            for (const rel of [
                'pages/board.tsx',
                'lib/format.ts',
                'lib/Card.tsx',
                'node_modules/fake-chart/index.js',
                'node_modules/fake-chart/style.css',
            ]) {
                expect(loaded.has(rel)).toBe(true);
            }
            // esbuild's metafile also lists the stdin entry key; like the
            // assembler, the comparison skips the stdin key and the platform
            // namespace (probed on 0.28.2: inputs are the 5 files plus
            // 'sa-page:main').
            const expected = Object.keys(inputs)
                .filter((key) => !key.startsWith('sa-platform:') && key !== 'sa-page:main' && key !== '<stdin>')
                .sort();
            expect([...loaded.keys()].sort()).toEqual(expected);
            expect(Object.keys(bundle.sources).sort()).toEqual(['lib/Card.tsx', 'lib/format.ts', 'pages/board.tsx']);
            // Provenance: the string handed to onLoaded is the string
            // published — project bytes equal their sources entry, package
            // bytes equal an independent post-bundle disk read.
            for (const [rel, text] of Object.entries(bundle.sources)) {
                expect(loaded.get(rel)).toBe(text);
            }
            for (const rel of ['node_modules/fake-chart/index.js', 'node_modules/fake-chart/style.css']) {
                expect(loaded.get(rel)).toBe(fs.readFileSync(path.join(root, rel), 'utf8'));
            }
            expect(bundle.compiled).toContain('FAKE_CHART_MARK');
            expect(bundle.compiledCss).toContain('.fake');
        } finally {
            remove();
        }
    });

    // C1 redesign fail-closed: an extension with no loader mapping is
    // refused even when it arrives through an in-root package; a normal
    // in-root package (several files, a CSS import) still bundles through
    // the same reader.
    it('refuses an unmapped extension from an in-root package and still bundles a normal one', async () => {
        const { root, remove } = makeProject();
        try {
            writeRow1Project(root);
            const ok = await bundlePage('pages/board.tsx', root);
            expect(Object.keys(ok.sources).sort()).toEqual(['lib/Card.tsx', 'lib/format.ts', 'pages/board.tsx']);
            expect(ok.compiled).toContain('FAKE_CHART_MARK');

            writeFile(root, 'node_modules/rawpkg/package.json', '{"name":"rawpkg","version":"1.0.0","main":"index.js"}');
            writeFile(root, 'node_modules/rawpkg/index.js', `import blob from './blob.wasm';\nexport const m = String(blob);\n`);
            writeFile(root, 'node_modules/rawpkg/blob.wasm', 'WASM_BYTES_MARKER\n');
            writeFile(
                root,
                'pages/wasm.tsx',
                `import React from 'react';\nimport { m } from 'rawpkg';\n\nexport default function Wasm(): React.ReactElement {\n    return <div>{m}</div>;\n}\n`,
            );

            const error = await bundlePage('pages/wasm.tsx', root).then(
                () => null,
                (cause: unknown) => cause,
            );

            expect(error).toBeInstanceOf(PageBundleError);
            expect((error as PageBundleError).message).toContain('unsupported file type for a page');
            expect((error as PageBundleError).message).toContain('blob.wasm');
            expect((error as PageBundleError).message).not.toContain('WASM_BYTES_MARKER');
        } finally {
            remove();
        }
    });

    // C1 pnpm-style layout: an in-root package directory reached through a
    // symlinked node_modules entry (node_modules/pkg -> .store/..., both
    // inside the project root) bundles successfully. Skips on win32.
    it.skipIf(process.platform === 'win32')('bundles an in-root package reached through a symlinked package directory', async () => {
        const { root, remove } = makeProject();
        try {
            writeFile(root, '.store/pkg-1.0.0/pkg/package.json', '{"name":"pkg","version":"1.0.0","main":"index.js"}');
            writeFile(
                root,
                '.store/pkg-1.0.0/pkg/index.js',
                `import './style.css';\nexport const mark = 'PNPM_PKG_MARK';\n`,
            );
            writeFile(root, '.store/pkg-1.0.0/pkg/style.css', '.pnpm{color:blue}\n');
            fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
            fs.symlinkSync(path.join(root, '.store', 'pkg-1.0.0', 'pkg'), path.join(root, 'node_modules', 'pkg'));
            writeFile(
                root,
                'pages/board.tsx',
                `import React from 'react';\nimport { mark } from 'pkg';\n\nexport default function Board(): React.ReactElement {\n    return <div>{mark}</div>;\n}\n`,
            );

            const bundle = await bundlePage('pages/board.tsx', root);

            expect(bundle.compiled).toContain('PNPM_PKG_MARK');
            expect(bundle.compiledCss).toContain('.pnpm');
            expect(bundle.entrySource).toContain("from 'pkg'");
        } finally {
            remove();
        }
    });

    // C1 structural guard: every byte esbuild consumes is read inside the
    // admitted reader, so a future edit cannot reintroduce a pathname read
    // — or hand a file back to esbuild to read itself — without failing
    // here. The reader body is extracted by brace match, as the assembly
    // sweep row does; the markers pin that the extraction reached the real
    // end of the function.
    it('keeps every byte read inside the admitted reader', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/utils/page-bundle.ts'), 'utf8');

        expect(src).toContain('function readAdmitted');
        const start = src.indexOf('function readAdmitted');
        // The parameter list may hold parens of its own (the hooks object
        // type), so walk paren depth from its '(' instead of stopping at
        // the first ')'. The first balanced '{...}' after that is the body:
        // readAdmitted has a plain string return type, so there is no
        // object return-type annotation to skip.
        let k = src.indexOf('(', start);
        expect(k).toBeGreaterThan(start);
        let quote: '"' | "'" | '`' | null = null;
        let escaped = false;
        let parens = 0;
        let bodyOpen = -1;
        let j = k;
        while (j < src.length) {
            const ch = src.charAt(j);
            if (quote !== null) {
                if (escaped) {
                    escaped = false;
                } else if (ch === '\\') {
                    escaped = true;
                } else if (ch === quote) {
                    quote = null;
                }
            } else if (ch === '"' || ch === "'" || ch === '`') {
                quote = ch;
            } else if (ch === '(') {
                parens += 1;
            } else if (ch === ')') {
                parens -= 1;
                if (parens === 0) {
                    bodyOpen = src.indexOf('{', j);
                    break;
                }
            }
            j += 1;
        }
        expect(bodyOpen).toBeGreaterThan(j);
        const end = matchBraces(src, bodyOpen);
        expect(end).toBeGreaterThan(bodyOpen);
        const body = src.slice(bodyOpen, end);
        // Extraction reached the real end: the handle read and the identity
        // refusal live at the bottom of the reader.
        expect(body).toContain('readFileSync(fd');
        expect(body).toContain('changed while it was being read');
        const outside = src.slice(0, bodyOpen) + src.slice(end);
        for (const token of ['readFileSync(', 'readFile(']) {
            expect(outside).not.toContain(token);
        }

        // The file-namespace onLoad handler must always hand esbuild
        // contents: extract its body the same way and forbid any return
        // without contents, so a future branch that reads via the admitted
        // reader and then hands the file back to esbuild (a null return)
        // fails here.
        const onLoadAnchor = `namespace: 'file' }, (args) =>`;
        expect(src).toContain(onLoadAnchor);
        const handlerStart = src.indexOf(onLoadAnchor);
        const handlerOpen = src.indexOf('{', handlerStart + onLoadAnchor.length);
        expect(handlerOpen).toBeGreaterThan(handlerStart);
        const hEnd = matchBraces(src, handlerOpen);
        expect(hEnd).toBeGreaterThan(handlerOpen);
        const handlerBody = src.slice(handlerOpen, hEnd);
        // Extraction reached the real end: the capture bookkeeping and the
        // contents return live at the bottom of the handler.
        expect(handlerBody).toContain('captured.set(args.path, contents)');
        expect(handlerBody).toContain('return { contents, loader }');
        expect(handlerBody).not.toContain('return null');
        expect(handlerBody).not.toContain('return undefined');
        expect(handlerBody).not.toMatch(/return\s*;/);
        // Provenance, structural: the handler's contents come from the one
        // admitted-reader call and from nowhere else. (a) the reader call
        // is present; (b) no other byte-reading call exists in the
        // handler; (c) every object return hands over contents or reports
        // errors; (d) contents is never a string literal.
        expect(handlerBody).toContain('readAdmitted(');
        for (const token of ['readFileSync', 'readFile', 'createReadStream', 'openSync', 'fs.read']) {
            expect(handlerBody).not.toContain(token);
        }
        const objectReturns = [...handlerBody.matchAll(/return\s*\{\s*([A-Za-z]+)/g)].map((match) => match[1]);
        expect(objectReturns.length).toBe(3);
        for (const name of objectReturns) {
            expect(['contents', 'errors']).toContain(name);
        }
        expect(handlerBody).not.toMatch(/contents:\s*['"`]/);
    });
});
