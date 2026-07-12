/**
 * solidactions skill exec <name> --target sandbox|host [...] -- <command...>
 *
 * ALWAYS executes the server-stored skill (the artifact) — never local edits;
 * that's `skill dev <dir>`. --target picks WHERE the stored skill executes:
 *   sandbox — the server-managed sandbox via crews MCP exec_skill (v1.30 behavior)
 *   host    — this machine, from a transparent revision-checked cache under
 *             ~/.solidactions/cache/skills/ (no visible pull step)
 * --target is REQUIRED (no default): a half-remembered command errors instead
 * of guessing where to execute. Both targets default --environment production —
 * moving execution between sandbox and host never silently changes the env.
 */
import fs from 'fs';
import axios from 'axios';
import chalk from 'chalk';
import path from 'path';
import { Config } from '../utils/config';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';
import { execLocally, shellQuoteArg } from './skill-run';
import { resolveCrewId, resolveRoleCrewPath, crewIdForPath } from '../utils/crew';
import {
    cacheDirFor, cacheOrigin, planCacheRefresh,
    CacheManifest, CacheScope, DesiredFile,
} from '../utils/skill-cache';
import {
    applyCachePlan, onDiskHashes, readManifest, sha256Hex, withCacheLock,
} from '../utils/skill-cache-fs';
import { normalizeBundle, fetchBinaryReference, SkillBundle } from '../utils/skill-bundle';

export interface SkillExecOptions {
    target?: string;
    role?: string;
    inCrew?: string;
    crew?: string;
    environment?: string;
    envFile?: string;
}

/** Pure invocation checks (option matrix + name shape). Returns error text or null. */
export function validateExecInvocation(name: string, options: SkillExecOptions): string | null {
    if (options.target !== 'sandbox' && options.target !== 'host') {
        return "--target is required: 'sandbox' (run in the server sandbox) or 'host' (run on this machine from the stored skill)";
    }
    if (name.startsWith('./') || name.startsWith('../') || path.isAbsolute(name)) {
        return `'${name}' looks like a directory — skill exec executes the server-stored skill by name. To run a working copy: skill dev ${name}`;
    }
    if (options.target === 'sandbox' && options.crew) {
        return '--crew only applies to --target host (sandbox variable composition is server-side)';
    }
    if (options.target === 'sandbox' && options.envFile) {
        return '--env-file only applies to --target host (the sandbox env is composed server-side)';
    }
    if (options.role && options.crew) {
        return '--crew conflicts with --role: a role-scoped skill takes its variables from the crew the role lives in';
    }
    if (options.inCrew && !options.role) {
        return '--in-crew requires --role';
    }
    return null;
}

export async function skillExecWithConfig(
    name: string,
    commandParts: string[],
    options: SkillExecOptions,
    config: Config,
): Promise<void> {
    const invalid = validateExecInvocation(name, options);
    if (invalid) {
        process.stderr.write(chalk.red(`error: ${invalid}\n`));
        process.exit(1);
    }
    if (fs.existsSync(name) && fs.statSync(name).isDirectory()) {
        process.stderr.write(chalk.red(`error: '${name}' looks like a directory — skill exec executes the server-stored skill by name. To run a working copy: skill dev ${name}\n`));
        process.exit(1);
    }
    if (commandParts.length === 0) {
        process.stderr.write(chalk.red('error: no command given — usage: skill exec <name> --target sandbox|host -- <command...>\n'));
        process.exit(1);
    }

    const environment = options.environment ?? 'production';

    if (options.target === 'sandbox') {
        await execInSandbox(name, commandParts, options, environment, config);
    } else {
        await execOnHost(name, commandParts, options, environment, config);
    }
}

async function execInSandbox(
    name: string,
    commandParts: string[],
    options: SkillExecOptions,
    environment: string,
    config: Config,
): Promise<void> {
    const command = commandParts.map(shellQuoteArg).join(' ');

    const isRole = Boolean(options.role);
    const tool = isRole ? 'roles' : 'skills';
    const args: Record<string, unknown> = isRole
        ? { action: 'exec_skill', role: options.role, name, command }
        : { action: 'exec_skill', identifier: name, command };
    if (options.environment) args.environment = options.environment;
    if (isRole && options.inCrew) args.in_crew = options.inCrew;

    process.stderr.write(chalk.blue(`▶ stored skill ${name} → sandbox (${environment})\n`));

    let result: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        result = await callCrewsTool(config, tool, args);
    } catch (e: any) {
        process.stderr.write(chalk.red(`error: ${e.message}\n`));
        process.exit(1);
    }

    if (!result.ok) {
        const code = result.data?.code ?? 'unknown_error';
        const message = result.data?.message ?? 'MCP returned an error with no message';
        process.stderr.write(chalk.red(`error: ${code}: ${message}\n`));
        process.exit(1);
    }

    const data = result.data as { stdout?: string; stderr?: string; exit_code?: number; status?: string };
    if (data.stdout) process.stdout.write(data.stdout.endsWith('\n') ? data.stdout : data.stdout + '\n');
    if (data.stderr) process.stderr.write(data.stderr.endsWith('\n') ? data.stderr : data.stderr + '\n');
    process.stderr.write(chalk.blue(`remote exec: status=${data.status ?? 'unknown'} exit_code=${data.exit_code ?? 'unknown'}\n`));
    process.exit(data.exit_code ?? 1);
}

async function execOnHost(
    name: string,
    commandParts: string[],
    options: SkillExecOptions,
    environment: string,
    config: Config,
): Promise<void> {
    const isRole = Boolean(options.role);
    const tool = isRole ? 'roles' : 'skills';
    const locator: Record<string, unknown> = isRole
        ? { role: options.role, name, ...(options.inCrew ? { in_crew: options.inCrew } : {}) }
        : { identifier: name };

    // 1. Fetch the bundle.
    let result: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        result = await callCrewsTool(config, tool, isRole
            ? { action: 'read_skill', ...locator }
            : { action: 'read', ...locator });
    } catch (e: any) {
        process.stderr.write(chalk.red(`error: ${e.message}\n`));
        process.exit(1);
    }
    if (!result.ok) {
        const code = result.data?.code ?? 'unknown_error';
        const message = result.data?.message ?? 'MCP returned an error with no message';
        process.stderr.write(chalk.red(`error: ${code}: ${message}\n`));
        process.exit(1);
    }

    const bundle: SkillBundle = normalizeBundle(result.data);
    for (const unsafe of bundle.skippedUnsafe) {
        process.stderr.write(chalk.yellow(`warn: skipping unsafe reference key: ${unsafe}\n`));
    }

    // 2. Resolve crew identity (vars + cache scope).
    let crewId: string | number | null = null;
    let scope: CacheScope = { kind: 'shared' };
    if (isRole) {
        const crewPath = await resolveRoleCrewPath(config, options.role as string, options.inCrew);
        crewId = await crewIdForPath(config, crewPath);
        scope = { kind: 'role', crewPath, role: options.role as string };
    } else if (options.crew) {
        crewId = (await resolveCrewId(config, options.crew)).id;
    } else {
        process.stderr.write(chalk.gray('no --crew given — running without crew variables (shared-skill parity)\n'));
    }

    // 3. Plan + refresh the cache under the lock.
    const cacheDir = cacheDirFor(config, scope, name);
    const origin = cacheOrigin(config);

    const desired: Record<string, DesiredFile> = { 'SKILL.md': { kind: 'text', sha256: sha256Hex(bundle.skillMd) } };
    for (const [p, content] of Object.entries(bundle.textFiles)) {
        desired[p] = { kind: 'text', sha256: sha256Hex(content) };
    }
    for (const [p, ref] of Object.entries(bundle.binaryFiles)) {
        desired[p] = { kind: 'binary', blobSha: ref.blobSha };
    }

    await withCacheLock(cacheDir, async () => {
        const manifest = readManifest(cacheDir);
        const onDisk = onDiskHashes(cacheDir, [...new Set([...Object.keys(desired), ...Object.keys(manifest?.files ?? {})])]);
        const plan = planCacheRefresh({ manifest, origin, identity: bundle.identity, desired, onDisk });

        if (plan.action === 'refresh') {
            const contents: Record<string, Buffer | string> = {};
            const newFiles: CacheManifest['files'] = {};

            for (const p of Object.keys(desired)) {
                const spec = desired[p];
                if (spec.kind === 'text') {
                    const content = p === 'SKILL.md' ? bundle.skillMd : bundle.textFiles[p];
                    if (plan.writes.includes(p)) contents[p] = content;
                    newFiles[p] = { sha256: spec.sha256 as string };
                } else {
                    if (plan.writes.includes(p)) {
                        const ref = bundle.binaryFiles[p];
                        const bytes = await fetchBinaryReference(config, tool as 'skills' | 'roles', locator, p, { size: ref.size, blobSha: ref.blobSha });
                        contents[p] = bytes;
                        newFiles[p] = { sha256: sha256Hex(bytes), blob_sha: spec.blobSha };
                    } else {
                        // Invariant: the planner only omits a binary from writes when the
                        // manifest entry exists and matches (upstreamSame && diskSame), so
                        // this carry-over cannot be undefined.
                        newFiles[p] = manifest?.files[p] as CacheManifest['files'][string];
                    }
                }
            }

            applyCachePlan(cacheDir, plan, contents, {
                schema_version: 1,
                origin,
                doc_id: bundle.identity.docId,
                published: bundle.identity.published,
                execution_revision_id: bundle.identity.executionRevisionId,
                files: newFiles,
            });
        }
    });

    // 4. Resolve crew variables.
    let resolved: Record<string, string> = {};
    let skippedSecrets: string[] = [];
    if (crewId !== null) {
        try {
            const response = await axios.get(
                `${config.host}/api/v1/crews/${crewId}/variables/resolve?environment=${encodeURIComponent(environment)}`,
                { headers: getApiHeaders(config) },
            );
            resolved = response.data?.variables ?? {};
            skippedSecrets = response.data?.skipped_secrets ?? [];
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: failed to resolve crew variables: ${e?.response?.data?.message ?? e.message}\n`));
            process.exit(1);
        }
    }

    // 5. Run.
    if (!bundle.identity.published) {
        process.stderr.write(chalk.yellow('running unpublished draft revision\n'));
    }
    execLocally({
        dir: cacheDir,
        commandParts,
        environment,
        resolved,
        skippedSecrets,
        envFile: options.envFile,
        config,
        banner: `▶ stored skill ${name} @ rev ${bundle.identity.executionRevisionId ?? '?'} → local cache (${environment})`,
    });
}

export async function skillExec(name: string, commandParts: string[], options: SkillExecOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await skillExecWithConfig(name, commandParts, options, config);
}
