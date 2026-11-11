import fs from 'fs';
import path from 'path';
import { build, version as esbuildVersion } from 'esbuild';
import type { Message, Metafile, Plugin } from 'esbuild';

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

type CaptureLoader = 'ts' | 'tsx' | 'js' | 'jsx' | 'json' | 'css' | 'local-css' | 'text';

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
        case '.txt':
            return 'text';
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
    // esbuild keeps the returning plugin's name on a plugin error
    // (probed on 0.28.2: pluginName "sa-capture"/"sa-platform", id "").
    // A plugin error is classified by what it IS — its own text — never
    // by where it is reported: the entry's outside-root refusal is
    // reported from the virtual sa-page:main import, where a
    // location-based rule misreads it as a missing default export.
    const pluginError = message.pluginName === 'sa-platform' || message.pluginName === 'sa-capture';
    const reportedFromMain = message.location?.file === MAIN || message.location?.file === '<stdin>';
    if (pluginError && reportedFromMain) return message.text;
    const fromMain = reportedFromMain;
    const computed = message.id === 'unsupported-dynamic-import' || message.id === 'unsupported-require-call';
    const text = fromMain ? NO_DEFAULT_EXPORT : computed ? COMPUTED_SPECIFIER : message.text;
    if (fromMain || !message.location?.file) return text;
    const file = toPosix(path.relative(projectDir, path.resolve(projectDir, message.location.file)));
    return `${file}:${message.location.line}:${message.location.column}: ${text}`;
}

// Source assembly is a pure function of the bytes captured during the
// build and the build's metafile: it walks the captured map (keyed by the
// exact path esbuild passed to onLoad) and the metafile decides which of
// those paths were part of the build. Nothing here may consult the live
// tree, so a file replaced after compilation cannot change the published
// snapshot. The sweep row `keeps source assembly free of filesystem
// calls` pins that shape at the source level.
export function assembleSources(
    captured: ReadonlyMap<string, string>,
    metafile: { inputs: Record<string, { format?: string }> },
    realRoot: string,
    entryKey: string,
): { sources: Record<string, string>; entrySource: string } {
    if (metafile.inputs[entryKey]?.format !== 'esm') throw new PageBundleError(NO_DEFAULT_EXPORT);
    const builtKeys = new Set(Object.keys(metafile.inputs).map(toPosix));
    const sources: Record<string, string> = {};
    let totalBytes = 0;
    for (const [absPath, text] of captured) {
        const key = toPosix(path.relative(realRoot, absPath));
        if (key.split('/').includes('node_modules')) continue;
        if (!builtKeys.has(key)) continue;
        sources[key] = text;
        totalBytes += Buffer.byteLength(text);
    }
    for (const key of Object.keys(metafile.inputs)) {
        if (key.startsWith(`${PLATFORM_NAMESPACE}:`) || key === MAIN || key === '<stdin>') continue;
        const posix = toPosix(key);
        // An absolute key is never skipped as node_modules: outside-root
        // is the outside refusal, inside-root is an unexpected-path refusal.
        if (path.isAbsolute(key) || /^[A-Za-z]:[\\/]/.test(key) || posix.startsWith('/')) {
            if (isOutsideRoot(path.relative(realRoot, key))) {
                throw new PageBundleError(`${posix}: imported from outside the project directory; a page can only import files inside its project`);
            }
            throw new PageBundleError(`${posix}: unexpected absolute input path`);
        }
        // Containment first: a `..`-prefixed key is never skipped as
        // node_modules, it is a refusal.
        if (isOutsideRoot(path.relative(realRoot, path.resolve(realRoot, key)))) {
            throw new PageBundleError(`${toPosix(key)}: imported from outside the project directory; a page can only import files inside its project`);
        }
        if (posix.split('/').includes('node_modules')) continue;
        if (!(posix in sources)) throw new PageBundleError(`${posix}: unsupported file type for a page`);
    }
    if (Object.keys(sources).length > SOURCES_MAX_FILES) throw new PageBundleError(`the page reads ${Object.keys(sources).length} project files, over the ${SOURCES_MAX_FILES} file limit`);
    if (totalBytes > SOURCES_MAX_BYTES) throw new PageBundleError(`the page's project files total ${totalBytes} bytes, over the 1 MiB (${SOURCES_MAX_BYTES} bytes) limit`);
    const entrySource = sources[entryKey];
    if (entrySource === undefined) throw new PageBundleError(`${entryKey}: unsupported file type for a page`);
    return { sources, entrySource };
}

export interface ReadAdmittedHooks {
    // beforeStat: once per read, after containment, before the pre-open stat (intermediate-directory swap window).
    beforeStat?: (admittedPath: string) => void;
    // beforeOpen: once per read, after the pre-open stat, before the open (check-to-open window).
    beforeOpen?: (admittedPath: string) => void;
    // afterOpen: once per read, after open+fstat+kernel check, before the post-open verification.
    afterOpen?: (admittedPath: string) => void;
}

// ONE reader serves every file esbuild loads, project files and in-root
// node_modules alike: onLoad always returns contents for a file-namespace
// path, never null, so esbuild never reads a file from disk itself. The
// returned bytes are read from the open handle whose post-open
// verification matches the admitted file; anything else is a refusal
// naming the path. Nothing is re-read.
export function readAdmitted(requestedPath: string, realRoot: string, hooks?: ReadAdmittedHooks): string {
    const requestedDisplay = toPosix(path.relative(realRoot, requestedPath));
    let real: string;
    try {
        real = fs.realpathSync(requestedPath);
    } catch {
        throw new PageBundleError(`${requestedDisplay}: could not resolve the real path`);
    }
    const display = toPosix(path.relative(realRoot, real));
    if (isOutsideRoot(path.relative(realRoot, real))) {
        throw new PageBundleError(`${display}: imported from outside the project directory; a page can only import files inside its project`);
    }
    // TEST SEAM beforeStat: strictly between the containment check and
    // the pre-open stat.
    hooks?.beforeStat?.(real);
    // The pre-open stat records the admitted identity AND the regular-file
    // gate. A swap of the admitted file for another IN-ROOT regular file
    // here is not detectable and is harmless to the outside-root rule: the
    // read bytes still come from a file inside the root and are the bytes
    // captured.
    let before: fs.Stats;
    try {
        before = fs.statSync(real);
    } catch {
        throw new PageBundleError(`${display}: changed while it was being read; deploy again`);
    }
    if (!before.isFile()) {
        throw new PageBundleError(`${display}: not a regular file`);
    }
    // TEST SEAM beforeOpen: after the pre-open stat, before the open.
    hooks?.beforeOpen?.(real);
    let fd: number;
    try {
        fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch {
        throw new PageBundleError(`${display}: changed while it was being read; deploy again`);
    }
    try {
        const after = fs.fstatSync(fd);
        if (!after.isFile()) {
            throw new PageBundleError(`${display}: changed while it was being read; deploy again`);
        }
        // Where the OPEN HANDLE really lives, asked from the kernel: an
        // intermediate directory swapped for an outside symlink between
        // the admission realpath and the open lands here, while
        // O_NOFOLLOW only guards the final component.
        let fdReal: string | null = null;
        try {
            fdReal = fs.realpathSync(`/proc/self/fd/${fd}`);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const failedPath = String((error as { path?: unknown }).path ?? '');
            if (failedPath.endsWith(' (deleted)')) {
                throw new PageBundleError(`${display}: changed while it was being read; deploy again`);
            }
            // No /proc on this platform (macOS, Windows, restricted
            // containers): skip the kernel check and rely on the fallback
            // layer below. Node has no openat/F_GETPATH; where /proc is
            // unavailable a directory swapped twice in a few microseconds
            // is the documented residual; the resolver's own path stats
            // only choose paths, never bytes. Never skip silently on
            // Linux: any other readlink failure refuses.
            if (process.platform === 'linux' && code !== 'ENOENT' && code !== 'ENOTDIR') {
                throw new PageBundleError(`${display}: changed while it was being read; deploy again`);
            }
            fdReal = null;
        }
        if (fdReal !== null && isOutsideRoot(path.relative(realRoot, fdReal))) {
            throw new PageBundleError(`${display}: imported from outside the project directory; a page can only import files inside its project`);
        }
        // The open handle must still match the pre-open identity: this
        // catches a swap in the beforeOpen window above.
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
            throw new PageBundleError(`${display}: changed while it was being read; deploy again`);
        }
        // TEST SEAM afterOpen: after the open, before the post-open
        // verification below.
        hooks?.afterOpen?.(real);
        // The comparison stat is taken AFTER the open: it must describe
        // the same file the handle does. Best-effort fallback layer for
        // platforms without /proc: the path must still resolve to the
        // admitted file.
        let post: fs.Stats;
        try {
            post = fs.statSync(real);
        } catch {
            throw new PageBundleError(`${display}: changed while it was being read; deploy again`);
        }
        // dev+ino is the identity; size is compared too because ino is 0
        // or otherwise unreliable on some platforms. Windows is
        // best-effort: the predicates above are source-level there and the
        // suite skips symlink rows on win32.
        if (!post.isFile() || after.dev !== post.dev || after.ino !== post.ino || after.size !== post.size) {
            throw new PageBundleError(`${display}: changed while it was being read; deploy again`);
        }
        let reread: string;
        try {
            reread = fs.realpathSync(real);
        } catch {
            throw new PageBundleError(`${display}: changed while it was being read; deploy again`);
        }
        if (reread !== real) {
            throw new PageBundleError(`${display}: changed while it was being read; deploy again`);
        }
        return fs.readFileSync(fd, 'utf8');
    } finally {
        fs.closeSync(fd);
    }
}

export async function bundlePage(
    entryPath: string,
    projectDir: string,
    hooks?: {
        afterBundle?: () => void | Promise<void>;
        beforeStat?: (admittedPath: string) => void;
        beforeOpen?: (admittedPath: string) => void;
        afterOpen?: (admittedPath: string) => void;
        // TEST SEAM: observes esbuild's own metafile once, after the build.
        onMetafile?: (metafile: Metafile) => void;
        // TEST SEAM: fires for every file-namespace path the plugin hands
        // contents for, immediately before the return, with that string.
        onLoaded?: (absPath: string, contents: string) => void;
    },
): Promise<PageBundle> {
    // test seam: the window between compilation and result assembly
    const root = path.resolve(projectDir);
    const entry = path.resolve(root, entryPath);
    // The root and entry are resolved ONCE before the build: realRoot is
    // the compilation directory and realEntry feeds the entry key. No
    // project path is resolved again after the build starts. A missing
    // entry keeps the lexical path so the refusal below reports it exactly
    // as before.
    const realRoot = fs.realpathSync(root);
    const realEntry = fs.existsSync(entry) ? fs.realpathSync(entry) : entry;
    const entryKey = toPosix(path.relative(realRoot, realEntry));
    // Keyed by the exact path esbuild passes to onLoad: the association
    // between a compiled input and its bytes is fixed at capture time and
    // never re-resolved from the live tree.
    const captured = new Map<string, string>();
    const capturePlugin: Plugin = {
        name: 'sa-capture',
        setup(b) {
            b.onLoad({ filter: /.*/, namespace: 'file' }, (args) => {
                // Every file-namespace path — project files, in-root
                // node_modules files, any unmapped extension — is read
                // through the single admitted reader, and this handler
                // always returns its contents: it never returns null, so
                // esbuild never reads a file from disk itself. A real path
                // outside the root is refused naming its path (this
                // deliberately refuses hoisted/workspace packages resolving
                // above the project root), and its bytes never reach esbuild.
                // The plugin's contents come ONLY from this one admitted-reader
                // call: there is no other byte source in this handler, so
                // esbuild never reads a file from disk itself.
                let contents: string;
                try {
                    contents = readAdmitted(args.path, realRoot, hooks);
                } catch (error) {
                    if (error instanceof PageBundleError) return { errors: [{ text: error.message }] };
                    throw error;
                }
                // esbuild defaults *.module.css to the local-css loader (scoped
                // class names); return the same loader so capture is behavior-preserving.
                const loader: CaptureLoader | null = args.path.endsWith('.module.css')
                    ? 'local-css'
                    : loaderForExtension(path.extname(args.path));
                if (loader === null) {
                    return { errors: [{ text: `${toPosix(path.relative(realRoot, args.path))}: unsupported file type for a page` }] };
                }
                // Bytes the reader returns for a project file are recorded
                // in the captured map exactly as before (keyed by the path
                // esbuild passes) and are the bytes esbuild compiles;
                // node_modules bytes are consumed once and not recorded.
                if (!toPosix(args.path).split('/').includes('node_modules')) {
                    captured.set(args.path, contents);
                }
                hooks?.onLoaded?.(args.path, contents);
                return { contents, loader };
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
            absWorkingDir: realRoot,
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
    hooks?.onMetafile?.(result.metafile);
    await hooks?.afterBundle?.();
    // The resolved entry is checked against the project root before
    // assembly: an entry symlink pointing outside (even to a CommonJS
    // file, even across Windows drives) is an outside-the-project refusal,
    // not a missing default export. A missing entry keeps its lexical
    // in-project key and still reports the no-default-export message from
    // assembly below.
    if (isOutsideRoot(path.relative(realRoot, realEntry))) {
        throw new PageBundleError(`${entryKey}: imported from outside the project directory; a page can only import files inside its project`);
    }
    // entrySource, sources and compiled all come from the same pre-build
    // capture: assembly reads only the captured map and the metafile.
    const { sources, entrySource } = assembleSources(captured, result.metafile, realRoot, entryKey);

    const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text ?? '';
    const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
    const compiled = `${WRAP_PREFIX}${js}${WRAP_SUFFIX}`;
    if (/<\/script/i.test(compiled)) throw new PageBundleError('the compiled page contains "</script", which would end the script tag it is served in; split the string (for example "<\\/script")');
    const size = Buffer.byteLength(compiled);
    if (size > COMPILED_LIMIT_BYTES) throw new PageBundleError(`the compiled page is ${size} bytes, over the 2 MiB (${COMPILED_LIMIT_BYTES} bytes) limit`);
    return { compiled, compiledCss: css, sources, compilerVersion: esbuildVersion, entrySource };
}
