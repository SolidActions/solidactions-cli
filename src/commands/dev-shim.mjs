/**
 * dev-shim.mjs — ESM subprocess entrypoint for `solidactions dev`.
 *
 * WHY THIS FILE IS .mjs (NOT .ts):
 *   The CLI tsconfig compiles "module": "commonjs". tsc rewrites await import(x)
 *   to Promise.resolve(x).then(s => require(s)) in CJS output (confirmed in
 *   dist/commands/dev.js:217). A .ts shim compiled by this tsconfig would also
 *   produce require(), which runs under tsx's CJS hook — the CJS hook does NOT
 *   remap .js→.ts. A hand-written .mjs file bypasses tsc entirely, so its
 *   await import() stays a real ESM dynamic import. tsx loads .mjs files under
 *   the ESM loader, which DOES remap .js→.ts for all transitive imports.
 *
 * HOW IT IS SPAWNED:
 *   npx tsx dist/commands/dev-shim.mjs <userEntry.ts>
 *
 * CONTEXT (from parent, via env var — no secrets to disk):
 *   SOLIDACTIONS_DEV_SHIM_CONTEXT: JSON-encoded DevShimContext object (see below).
 *
 * RESULT (written to temp file, path in context):
 *   The result file path is passed in context.resultPath. A private temp file
 *   (mode 0o600, random UUID name) is written by the parent before spawn; the
 *   shim writes its result JSON there; the parent reads it and unlinks it.
 *
 * This file is copied to dist/commands/dev-shim.mjs by the build script.
 */

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';

/**
 * Serialize an unknown error value to a plain JSON-serialisable object.
 * JSON.stringify(new Error('x')) produces {} — this ensures the message
 * is preserved so the CLI's r.error?.message reads correctly.
 *
 * @param {unknown} e
 * @returns {{ message: string; name: string; stack?: string }}
 */
function serializeError(e) {
    if (e instanceof Error) {
        return { message: e.message, name: e.name, stack: e.stack };
    }
    return { message: String(e), name: 'Error' };
}

async function main() {
    const contextJson = process.env['SOLIDACTIONS_DEV_SHIM_CONTEXT'];

    if (!contextJson) {
        process.stderr.write('dev-shim: missing SOLIDACTIONS_DEV_SHIM_CONTEXT env var\n');
        process.exit(1);
    }

    let ctx;
    try {
        ctx = JSON.parse(contextJson);
    } catch (e) {
        process.stderr.write(`dev-shim: failed to parse context JSON: ${e?.message ?? e}\n`);
        process.exit(1);
    }

    const { entryPath, input, vars, mockBaseUrl, mockApiKey, runUuid, workerSessionId, resultPath } = ctx;

    // Resolve SDK from the user entry's directory — ensures we hit the same SDK
    // registry instance the workflow populated, not the CLI's own linked copy.
    const _require = createRequire(entryPath);

    let shimResult;

    try {
        // Import the user entry file. Under tsx's ESM loader (active because this
        // file is .mjs), dynamic import() correctly remaps .js-extension imports
        // to .ts files for all transitive requires in the user project.
        const mod = await import(entryPath);

        let descriptor;

        if (mod?.default && typeof mod.default?.run === 'function') {
            descriptor = mod.default;
        } else {
            const sdkMain = _require.resolve('@solidactions/sdk');
            const registryPath = path.resolve(sdkMain, '..', 'invoke', 'registry.js');
            const registry = _require(registryPath);
            descriptor = registry.__getRegisteredWorkflows()[0];
        }

        if (!descriptor) {
            shimResult = {
                result: {
                    status: 'failed',
                    error: serializeError(new Error('no workflow registered after importing the entry file')),
                    phase: 'run',
                },
            };
            fs.writeFileSync(resultPath, JSON.stringify(shimResult), { mode: 0o600 });
            process.exit(1);
            return;
        }

        // Create the run-row BEFORE invoking (descriptor is now available for
        // workflowName — preserves current behaviour where descriptor.name is
        // used at src/commands/dev.ts:319).
        const sdkMainForInvoke = _require.resolve('@solidactions/sdk');
        const httpClientPath = path.resolve(sdkMainForInvoke, '..', 'http_client.js');
        const { HttpClient } = _require(httpClientPath);
        try {
            const client = new HttpClient({ baseUrl: mockBaseUrl, apiKey: mockApiKey });
            await client.post('/runs/status', {
                workflowUUID: runUuid,
                status: 'PENDING',
                workflowName: descriptor.name ?? '',
                workflowClassName: '',
                workflowConfigName: '',
                output: null,
                error: null,
                authenticatedUser: '',
                assumedRole: '',
                authenticatedRoles: [],
                request: {},
                executorId: 'local-dev',
                applicationVersion: '0',
                applicationID: 'local-dev',
                createdAt: Date.now(),
                priority: 0,
                ownerXid: randomUUID(),
                options: {},
            });
        } catch (_e) {
            // Best-effort, symmetric with the parent's swallow.
        }

        // Build InvokeCtx using the context passed from the parent.
        const invokeCtx = {
            input: JSON.parse(input || '{}'),
            vars: Object.freeze(vars),
            run: {
                triggerId: 'local-dev',
                runUuid,
                runSecret: 'local-dev',
                workerSessionId,
            },
            app: {
                appVersion: '0',
                appId: 'local-dev',
                tenantId: 'local-dev',
            },
            api: {
                url: mockBaseUrl,
                key: mockApiKey,
            },
            mode: 'local',
        };

        // Invoke via internal SDK path (same resolution as runDev).
        const invokePath = path.resolve(sdkMainForInvoke, '..', 'invoke', 'invoke.js');
        const { invoke } = _require(invokePath);
        const result = await invoke(descriptor, invokeCtx);

        // Serialize Error objects before JSON.stringify (Error → {} otherwise).
        const serializedResult = {
            ...result,
            ...(result?.error ? { error: serializeError(result.error) } : {}),
        };

        shimResult = { result: serializedResult };
    } catch (e) {
        // Surface module-resolution failures with an actionable message.
        let errorObj = serializeError(e);
        if (e?.code === 'MODULE_NOT_FOUND' || /Cannot find module/i.test(errorObj.message)) {
            const attempted = e?.requireStack?.[0] ?? entryPath;
            errorObj = {
                ...errorObj,
                message:
                    `Cannot find module: ${errorObj.message}\n` +
                    `\nThis usually means a TypeScript file uses a .js-extension import (e.g. './lib/foo.js')\n` +
                    `but the real file is foo.ts and could not be found by the loader.\n` +
                    `\nVerify that your project's tsconfig.json sets "moduleResolution": "NodeNext" or "Bundler"\n` +
                    `and that all imported files exist as .ts sources in: ${path.dirname(attempted)}`,
            };
        }
        shimResult = {
            result: { status: 'failed', error: errorObj, phase: 'run' },
        };
    }

    fs.writeFileSync(resultPath, JSON.stringify(shimResult), { mode: 0o600 });
    process.exit(shimResult.result?.status === 'failed' ? 1 : 0);
}

main().catch((e) => {
    process.stderr.write(`dev-shim: unexpected top-level error: ${e?.message ?? e}\n`);
    process.exit(1);
});
