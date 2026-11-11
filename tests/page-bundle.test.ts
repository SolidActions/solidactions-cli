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
import { bundlePage, PageBundleError } from '../src/utils/page-bundle';

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
});
