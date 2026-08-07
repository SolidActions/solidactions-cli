import type { Archiver, TarOptions } from 'archiver';

type ArchiverModule = typeof import('archiver');

// Kept in an untransformed CommonJS bridge because TypeScript rewrites
// import() to require() for this project, and require() cannot load archiver
// v8's ESM-only entry point on Node 18.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const importArchiver = require('./archiver-loader.cjs') as () => Promise<ArchiverModule>;

export async function createTarArchive(options: TarOptions): Promise<Archiver> {
    const { TarArchive } = await importArchiver();
    return new TarArchive(options);
}
