import fs from 'fs';
import path from 'path';
import { build, version as esbuildVersion } from 'esbuild';
import type { Message, Plugin } from 'esbuild';

export const PLATFORM_MODULES = ['react', 'react-dom', 'recharts', '@tanstack/react-table', 'sa', '@solidactions/sa'] as const;
export const COMPILED_LIMIT_BYTES = 2 * 1024 * 1024;
export const SOURCES_MAX_FILES = 50;
export const SOURCES_MAX_BYTES = 1024 * 1024;

export interface PageBundle {
    compiled: string;
    compiledCss: string;
    sources: Record<string, string>;
    compilerVersion: string;
    entrySource: string;
}

export class PageBundleError extends Error {}

const MAIN = 'sa-page:main';
const PLATFORM_NAMESPACE = 'sa-platform';
const WRAP_PREFIX = 'globalThis.__saPlatform.define(function () {\n';
const WRAP_SUFFIX = '});\n';
const NO_DEFAULT_EXPORT = 'a page must export its component as the default export';
const COMPUTED_SPECIFIER = 'import() and require() of a computed specifier are not allowed in a page; import platform modules by name: react, react-dom, recharts, @tanstack/react-table, sa';
const PLATFORM_LIST = 'react, react-dom, recharts, @tanstack/react-table, sa, @solidactions/sa';

function platformPlugin(): Plugin {
    return {
        name: 'sa-platform',
        setup(b) {
            b.onResolve({ filter: /^[^./]/ }, (args) => {
                if ((PLATFORM_MODULES as readonly string[]).includes(args.path)) {
                    return { path: args.path, namespace: PLATFORM_NAMESPACE };
                }
                if (PLATFORM_MODULES.some(name => args.path.startsWith(`${name}/`))) {
                    return { errors: [{ text: `import "${args.path}" is not available: platform modules are imported by name only (${PLATFORM_LIST})` }] };
                }
                return null;
            });
            b.onLoad({ filter: /.*/, namespace: PLATFORM_NAMESPACE }, (args) => ({
                contents: `module.exports = globalThis.__saPlatform.modules[${JSON.stringify(args.path)}];\n`,
                loader: 'js',
            }));
        },
    };
}

function toPosix(value: string): string {
    return value.split(path.sep).join('/').replace(/\\/g, '/');
}

type CaptureLoader = 'ts' | 'tsx' | 'js' | 'jsx' | 'json' | 'css' | 'local-css';

function loaderForExtension(ext: string): Exclude<CaptureLoader, 'local-css'> | null {
    switch (ext) {
        case '.ts':
        case '.mts':
        case '.cts':
            return 'ts';
        case '.tsx':
            return 'tsx';
        case '.js':
        case '.mjs':
        case '.cjs':
            return 'js';
        case '.jsx':
            return 'jsx';
        case '.json':
            return 'json';
        case '.css':
            return 'css';
        default:
            return null;
    }
}

// True when a project-relative path escapes the project root. A leading
// `..` path component means outside; a mere `..` prefix does not (files
// like `lib/..shared.ts` or dirs like `..lib/` are valid project paths).
// Check both separators: metafile keys are posix, but path.relative
// speaks the OS separator — and on Windows it returns an absolute drive
// path when the target is on another drive, which no prefix check sees.
function isOutsideRoot(relative: string): boolean {
    const posix = toPosix(relative);
    return path.isAbsolute(relative) || posix === '..' || posix.startsWith('../') || relative === '..' || relative.startsWith(`..${path.sep}`);
}

function describe(message: Message, projectDir: string): string {
    const fromMain = message.location?.file === MAIN || message.location?.file === '<stdin>';
    const computed = message.id === 'unsupported-dynamic-import' || message.id === 'unsupported-require-call';
    const text = fromMain ? NO_DEFAULT_EXPORT : computed ? COMPUTED_SPECIFIER : message.text;
    if (fromMain || !message.location?.file) return text;
    const file = toPosix(path.relative(projectDir, path.resolve(projectDir, message.location.file)));
    return `${file}:${message.location.line}:${message.location.column}: ${text}`;
}

export async function bundlePage(entryPath: string, projectDir: string, hooks?: { afterBundle?: () => void | Promise<void> }): Promise<PageBundle> {
    // test seam: the window between compilation and result assembly
    const root = path.resolve(projectDir);
    const entry = path.resolve(root, entryPath);
    // esbuild keys metafile inputs by real path: an entry reached through
    // a symlink (including a symlinked project root, as on macOS) must be
    // looked up by its resolved location. A missing entry keeps the lexical
    // path so the refusal below reports it exactly as before.
    const realRoot = fs.realpathSync(root);
    const realEntry = fs.existsSync(entry) ? fs.realpathSync(entry) : entry;
    const entryKey = toPosix(path.relative(realRoot, realEntry));
    const capturedByAbs = new Map<string, string>();
    const capturePlugin: Plugin = {
        name: 'sa-capture',
        setup(b) {
            b.onLoad({ filter: /.*/, namespace: 'file' }, (args) => {
                if (toPosix(args.path).split('/').includes('node_modules')) return null;
                // esbuild defaults *.module.css to the local-css loader (scoped
                // class names); return the same loader so capture is behavior-preserving.
                const loader: CaptureLoader | null = args.path.endsWith('.module.css')
                    ? 'local-css'
                    : loaderForExtension(path.extname(args.path));
                if (loader === null) return null;
                let text: string;
                try {
                    text = fs.readFileSync(args.path, 'utf8');
                } catch {
                    throw new PageBundleError(`${toPosix(path.relative(root, args.path))}: could not be read while it was being bundled; deploy again`);
                }
                let absReal: string;
                try {
                    absReal = fs.realpathSync(args.path);
                } catch {
                    absReal = args.path;
                }
                capturedByAbs.set(absReal, text);
                return { contents: text, loader };
            });
        },
    };
    let result;
    try {
        result = await build({
            stdin: {
                contents: `import Page from ${JSON.stringify(entry)};\nglobalThis.__saPlatform.mount(Page);\n`,
                resolveDir: root,
                sourcefile: MAIN,
                loader: 'js',
            },
            absWorkingDir: root,
            outdir: path.join(root, '.sa-page-out'),
            bundle: true,
            write: false,
            metafile: true,
            logLevel: 'silent',
            format: 'iife',
            target: 'es2022',
            platform: 'browser',
            charset: 'utf8',
            legalComments: 'none',
            minify: false,
            jsx: 'transform',
            jsxFactory: 'React.createElement',
            jsxFragment: 'React.Fragment',
            logOverride: { 'unsupported-dynamic-import': 'error', 'unsupported-require-call': 'error' },
            tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
            plugins: [platformPlugin(), capturePlugin],
        });
    } catch (error) {
        if (error instanceof PageBundleError) throw error;
        const errors = (error as { errors?: Message[] }).errors;
        if (!Array.isArray(errors) || errors.length === 0) throw new PageBundleError(String((error as Error).message ?? 'bundle failed'));
        throw new PageBundleError([...new Set(errors.slice(0, 20).map(message => describe(message, root)))].join('\n'));
    }
    await hooks?.afterBundle?.();
    // The resolved entry is checked against the project root before the
    // format check: an entry symlink pointing outside (even to a CommonJS
    // file, even across Windows drives) is an outside-the-project refusal,
    // not a missing default export. A missing entry keeps its lexical
    // in-project key and still reports the no-default-export message below.
    if (isOutsideRoot(path.relative(realRoot, realEntry))) {
        throw new PageBundleError(`${entryKey}: imported from outside the project directory; a page can only import files inside its project`);
    }
    if (result.metafile.inputs[entryKey]?.format !== 'esm') throw new PageBundleError(NO_DEFAULT_EXPORT);

    const sources: Record<string, string> = {};
    let totalBytes = 0;
    for (const key of Object.keys(result.metafile.inputs)) {
        if (key.startsWith(`${PLATFORM_NAMESPACE}:`) || key === MAIN || key === '<stdin>') continue;
        const relative = path.relative(root, path.resolve(root, key));
        const posix = toPosix(relative);
        if (isOutsideRoot(relative)) {
            throw new PageBundleError(`${toPosix(key)}: imported from outside the project directory; a page can only import files inside its project`);
        }
        if (posix.split('/').includes('node_modules')) continue;
        const resolved = path.resolve(root, key);
        let absReal = resolved;
        try {
            absReal = fs.realpathSync(resolved);
        } catch {
            absReal = resolved;
        }
        const text = capturedByAbs.get(absReal) ?? capturedByAbs.get(resolved);
        if (text === undefined) throw new PageBundleError(`${posix}: unsupported file type for a page`);
        sources[posix] = text;
        totalBytes += Buffer.byteLength(text);
    }
    if (Object.keys(sources).length > SOURCES_MAX_FILES) throw new PageBundleError(`the page reads ${Object.keys(sources).length} project files, over the ${SOURCES_MAX_FILES} file limit`);
    if (totalBytes > SOURCES_MAX_BYTES) throw new PageBundleError(`the page's project files total ${totalBytes} bytes, over the 1 MiB (${SOURCES_MAX_BYTES} bytes) limit`);

    const entrySource = capturedByAbs.get(realEntry);
    if (entrySource === undefined) throw new PageBundleError(`${entryKey}: unsupported file type for a page`);

    const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text ?? '';
    const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
    const compiled = `${WRAP_PREFIX}${js}${WRAP_SUFFIX}`;
    if (/<\/script/i.test(compiled)) throw new PageBundleError('the compiled page contains "</script", which would end the script tag it is served in; split the string (for example "<\\/script")');
    const size = Buffer.byteLength(compiled);
    if (size > COMPILED_LIMIT_BYTES) throw new PageBundleError(`the compiled page is ${size} bytes, over the 2 MiB (${COMPILED_LIMIT_BYTES} bytes) limit`);
    return { compiled, compiledCss: css, sources, compilerVersion: esbuildVersion, entrySource };
}
