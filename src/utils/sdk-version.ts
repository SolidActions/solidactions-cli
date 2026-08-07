import fs from 'fs';
import path from 'path';

const SDK_PACKAGE = '@solidactions/sdk';

/**
 * Resolve the git ref used when fetching SDK docs from the solidactions-ts-sdk
 * repo, derived from THIS CLI's own `package.json` declaration of
 * `@solidactions/sdk`.
 *
 * `ai init` used to fetch `docs/sdk-reference.md` from that repo's default
 * branch, so a freshly-scaffolded project got whatever happened to be on SDK
 * `main` — documenting APIs the SDK version this CLI is built against doesn't
 * ship yet. Deriving the ref from our own declared dependency means a future
 * dependency bump moves the docs ref with it; there is no second constant to
 * forget to update.
 *
 * Note this tracks the CLI's own declaration, NOT the SDK version in whatever
 * project `ai init` is run against. Serving docs matched to the target
 * project's installed SDK is a separate concern, tracked separately.
 *
 * The declared range's minimum is used (`^0.7.3` → `v0.7.3`), matching the
 * `vX.Y.Z` tag format the SDK repo publishes.
 */
/**
 * Convert a declared semver range into the SDK repo's `vX.Y.Z` tag format,
 * using the range's minimum version (`^0.7.3` → `v0.7.3`).
 *
 * Exported so the conversion — including its rejection of ranges with no
 * explicit minimum — is testable without touching the filesystem.
 */
export function sdkRefFromRange(declared: string): string {
    // Strip a leading range operator (^, ~, >=, v) to get the minimum version.
    const version = declared.replace(/^[\^~>=<\sv]*/, '');
    if (!/^\d+\.\d+\.\d+/.test(version)) {
        throw new Error(
            `Cannot derive an SDK docs tag from ${SDK_PACKAGE} range "${declared}" — expected a range with an explicit minimum version (e.g. "^0.7.3").`,
        );
    }
    return `v${version}`;
}

export function sdkDocsRef(): string {
    // `__dirname` is <pkg>/src/utils under vitest and <pkg>/dist/utils once
    // built, so `../..` is the package root in both cases — and in a published
    // install, since npm always ships package.json alongside `dist`.
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');

    let declared: string | undefined;
    try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        declared = pkg.dependencies?.[SDK_PACKAGE] ?? pkg.devDependencies?.[SDK_PACKAGE];
    } catch (error: any) {
        throw new Error(
            `Could not read ${packageJsonPath} to determine the SDK docs version: ${error.message}`,
        );
    }

    if (!declared) {
        throw new Error(
            `No ${SDK_PACKAGE} dependency declared in ${packageJsonPath} — cannot determine which SDK docs version to fetch.`,
        );
    }

    return sdkRefFromRange(declared);
}
