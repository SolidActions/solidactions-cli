import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import archiver from 'archiver';
import axios from 'axios';
import FormData from 'form-data';
import chalk from 'chalk';
import yaml from 'js-yaml';
import prompts from 'prompts';
import { SolidActionsConfig, parseYamlEnvVars } from '../utils/env';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { planDeployFiles } from '../utils/deploy-ignore';
import { buildProjectSlug } from '../utils/slug';
import { hasSolidActionsSkills } from '../utils/skills';

/** Printed when a deploy target has no SolidActions skill files installed. */
export const SKILLS_TIP_LINES = [
    'Tip: no SolidActions skill files found (.claude/skills/solidactions-*). Your AI assistant',
    'works much better with them — run `solidactions ai init --claude` (or --agents) in this',
    'directory to add them.',
];

/**
 * Validate project structure before deployment.
 * Checks for required files and SDK dependency.
 */
function validateProject(sourceDir: string): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for solidactions.yaml
    const solidactionsPath = path.join(sourceDir, 'solidactions.yaml');
    if (!fs.existsSync(solidactionsPath)) {
        errors.push('solidactions.yaml not found. This file defines your workflows.');
        return { valid: false, errors, warnings };
    }

    // Check for package.json
    const packageJsonPath = path.join(sourceDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        errors.push('package.json not found. Initialize with: npm init');
        return { valid: false, errors, warnings };
    }

    // Read and validate package.json
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    // Check for SDK - either @solidactions/sdk or bundled sdk folder
    const hasSdkPackage = '@solidactions/sdk' in allDeps;
    const hasBundledSdk = fs.existsSync(path.join(sourceDir, 'sdk'));

    if (!hasSdkPackage && !hasBundledSdk) {
        errors.push('Missing SDK in package.json dependencies. Run: npm install @solidactions/sdk');
    }

    // Check for TypeScript config if .ts files are used
    const srcDir = path.join(sourceDir, 'src');
    const hasTypeScriptFiles = fs.existsSync(srcDir) &&
        fs.readdirSync(srcDir).some(f => f.endsWith('.ts') || f.endsWith('.tsx'));

    if (hasTypeScriptFiles) {
        const tsconfigPath = path.join(sourceDir, 'tsconfig.json');
        if (!fs.existsSync(tsconfigPath)) {
            warnings.push('TypeScript files detected but tsconfig.json not found. Build may fail.');
        }
    }

    // Parse and validate solidactions.yaml
    try {
        const configContent = fs.readFileSync(solidactionsPath, 'utf8');
        const config = yaml.load(configContent) as SolidActionsConfig;

        if (!config || !config.workflows || !Array.isArray(config.workflows)) {
            errors.push('Invalid solidactions.yaml: workflows section is required.');
        } else {
            // Validate each workflow
            for (const wf of config.workflows) {
                if (!wf.name) {
                    errors.push(`Workflow missing required 'name' field.`);
                    continue;
                }

                // Must have either command: or file:
                if (!wf.command && !wf.file) {
                    errors.push(`Workflow "${wf.name}": must specify either 'command:' or 'file:'.`);
                    continue;
                }

                // If file: is specified, verify the file exists
                if (wf.file) {
                    const filePath = path.join(sourceDir, wf.file);
                    if (!fs.existsSync(filePath)) {
                        errors.push(`Workflow "${wf.name}": file "${wf.file}" not found.`);
                    }
                }
            }
        }
    } catch (err: any) {
        errors.push(`Failed to parse solidactions.yaml: ${err.message}`);
    }

    return { valid: errors.length === 0, errors, warnings };
}


/**
 * When `noCache` is true, returns an archive entry with a unique name and
 * random content that busts the build-layer content hash (Blaxel/Daytona S3
 * MD5 and BuildKit COPY . layer). Returns null when noCache is false/undefined.
 */
export function cacheBusterEntry(noCache: boolean): { name: string; content: string } | null {
    if (!noCache) {
        return null;
    }
    const uuid = randomUUID();
    return {
        name: `tenantcode/sa-nocache-${uuid}`,
        content: `force-rebuild ${uuid} ${Date.now()}`,
    };
}

interface DeployOptions {
    env?: string;
    create?: boolean;
    configOnly?: boolean;
    noCache?: boolean;
}

/**
 * Push YAML env declarations to the project.
 * This registers all YAML-declared vars and their mappings.
 */
async function pushYamlDeclarations(
    config: { host: string; apiKey: string; workspaceId?: string },
    projectSlug: string,
    yamlConfig: SolidActionsConfig
): Promise<void> {
    const parsedVars = parseYamlEnvVars(yamlConfig);
    if (parsedVars.length === 0) {
        return;
    }

    // Build the declarations array
    const declarations = parsedVars.map(v => ({
        env_name: v.key,
        yaml_default_global_key: v.mappedTo,
        yaml_default_oauth_name: v.oauthName,
        source: 'yaml' as const,
    }));

    try {
        await axios.post(
            `${config.host}/api/v1/projects/${projectSlug}/variable-mappings/sync-yaml`,
            { declarations },
            {
                headers: getApiHeaders(config, 'application/json'),
            }
        );
        console.log(chalk.gray(`Synced ${declarations.length} YAML env declarations`));
    } catch (error: any) {
        console.error(chalk.yellow('Warning: Failed to sync YAML declarations:'), error.response?.data?.message || error.message);
    }
}

/**
 * Returns true only when a 404 on the environment-specific project lookup
 * will cause the deploy command to abort (non-production environment and
 * --create was not passed). On these paths the workspace-mismatch warning
 * should print. On all success/create paths it must be suppressed.
 */
export function shouldPrintWorkspaceMismatch(environment: string, willCreate: boolean): boolean {
    return environment !== 'production' && !willCreate;
}

/**
 * Printed (after the server's own message) when a free-plan tenant hits the
 * dev/staging environment gate in a non-interactive context, or declines the
 * interactive fallback prompt.
 */
export const PLAN_LIMIT_NON_INTERACTIVE_HINT = 'Hint: pass -e production, or upgrade your plan for dev/staging environments.';

/**
 * True when `error` is the app's 422 response for a free-plan tenant hitting
 * the multi-environment gate on project auto-create:
 * `{ error: { code: 'plan_limit_reached', limit: 'multi_env', plan, max } }`.
 */
export function isPlanLimitReachedError(error: any): boolean {
    const data = error?.response?.data;
    return error?.response?.status === 422
        && data?.error?.code === 'plan_limit_reached'
        && data?.error?.limit === 'multi_env';
}

/**
 * POST /api/v1/projects to create a new environment-project record. Returns
 * the resolved slug (server-echoed slug, falling back to the requested one).
 * Throws the raw axios error on failure — callers decide how to handle it.
 */
async function createEnvironmentProject(
    config: { host: string; apiKey: string; workspaceId?: string },
    projectName: string,
    environment: string
): Promise<string> {
    const requestedSlug = buildProjectSlug(projectName, environment);
    const createResponse = await axios.post(`${config.host}/api/v1/projects`, {
        name: projectName,
        slug: requestedSlug,
        environment: environment,
    }, {
        headers: getApiHeaders(config, 'application/json'),
    });
    const slug = createResponse.data.slug || requestedSlug;
    if (process.env.SOLIDACTIONS_DEPLOY_DEBUG === '1') {
        process.stderr.write(`[deploy-debug] requestedSlug=${requestedSlug} responseSlug=${createResponse.data.slug ?? '(missing)'} responseName=${createResponse.data.name ?? '(missing)'} resolvedSlug=${slug}\n`);
    }
    return slug;
}

/**
 * Handles a 422 plan_limit_reached/multi_env error from the env-project
 * auto-create call (billing v0.5: free-plan tenants only get production).
 *
 * Interactive TTYs are offered a y/N fallback to production; declining exits
 * 1 with an upgrade hint. Non-interactive callers (CI, agents) never see a
 * prompt — they get the same hint and exit 1 immediately, so the command
 * never hangs waiting for input that will never arrive.
 *
 * On confirmed fallback, resolves (and creates if necessary) the production
 * project and returns its slug. Every other path calls process.exit(1) and
 * never returns.
 */
export async function handlePlanLimitReached(
    config: { host: string; apiKey: string; workspaceId?: string },
    projectName: string,
    error: any,
    productionExists: boolean | null,
    productionSlug: string | null
): Promise<string> {
    const serverMessage: string = error.response?.data?.message || 'Your plan does not support additional environments.';
    console.error(chalk.red(serverMessage));

    if (!process.stdin.isTTY) {
        console.error(chalk.yellow(PLAN_LIMIT_NON_INTERACTIVE_HINT));
        process.exit(1);
    }

    const response = await prompts({
        type: 'confirm',
        name: 'proceed',
        message: 'Your plan has a single production environment — deploy to production instead?',
        initial: false,
    });

    if (!response.proceed) {
        console.error(chalk.yellow(PLAN_LIMIT_NON_INTERACTIVE_HINT));
        process.exit(1);
    }

    if (productionExists === true && productionSlug !== null) {
        return productionSlug;
    }

    try {
        return await createEnvironmentProject(config, projectName, 'production');
    } catch (prodError: any) {
        console.error(chalk.red('Failed to create project:'), prodError.response?.data?.message || prodError.message);
        process.exit(1);
    }
}

export async function deploy(projectName: string, sourcePath?: string, options: DeployOptions = {}) {
    const config = await requireConfigWithWorkspace();

    let workspaceMismatchPrinted = false;
    const printWorkspaceMismatchOnce = (error: any) => {
        if (workspaceMismatchPrinted) return;
        const msg = error.response?.data?.message;
        if (typeof msg === 'string' && /Project .+ not found in your active workspace/.test(msg)) {
            console.error(chalk.yellow(msg));
            console.error('');
            workspaceMismatchPrinted = true;
        }
    };

    const sourceDir = sourcePath ? path.resolve(sourcePath) : process.cwd();

    // Capture whether -e was explicitly passed by the caller. Commander leaves
    // options.env as undefined when no default is set and the flag is omitted.
    const explicitEnv: string | undefined = options.env;

    if (!fs.existsSync(sourceDir)) {
        console.error(chalk.red(`Source directory not found: ${sourceDir}`));
        process.exit(1);
    }

    // Non-blocking: AI assistants work measurably better with the skill files
    // (field report: a 600-line skill file cracked the env-scope bug).
    if (!hasSolidActionsSkills(sourceDir)) {
        for (const line of SKILLS_TIP_LINES) {
            console.log(chalk.yellow(line));
        }
    }

    // -------------------------------------------------------------------------
    // First-deploy check — must happen BEFORE we apply any env default so that
    // first-time deploys without -e get a helpful error prompting a deliberate
    // environment choice, instead of silently defaulting. (Any environment can
    // stand alone — production is not required to exist first.)
    // -------------------------------------------------------------------------
    let productionExists: boolean | null = null; // null = unknown (error path)
    let productionSlug: string | null = null;

    try {
        const prodResponse = await axios.get(`${config.host}/api/v1/projects/${projectName}`, {
            headers: getApiHeaders(config),
        });
        productionExists = true;
        productionSlug = prodResponse.data.slug || prodResponse.data.name;
    } catch (error: any) {
        if (error.response?.status === 404) {
            productionExists = false;
            // Project doesn't exist yet — this is the normal first-deploy path.
            // Do NOT print a warning here; the deploy proceeds to create/deploy successfully.
        } else {
            // 5xx, network error, auth failure, etc. — fail conservatively rather
            // than treating the project as non-existent and potentially creating it.
            console.error(chalk.red('Failed to check project existence:'), error.response?.data?.message || error.message);
            process.exit(1);
        }
    }

    // Decision: if this is the first deploy (project doesn't exist yet) and no -e
    // flag was given, prompt the user to choose an environment explicitly so the
    // first deploy is deliberate. Any environment can be the first one.
    if (productionExists === false && explicitEnv === undefined) {
        console.error(chalk.red(`\nThis is the first deploy of "${projectName}" — please pick an environment explicitly:\n`));
        console.error(`  solidactions project deploy ${projectName} <path> -e production    # most projects start here`);
        console.error(`  solidactions project deploy ${projectName} <path> -e dev            # start in dev (no production required first)`);
        console.error(`  solidactions project deploy ${projectName} <path> -e staging        # start in staging`);
        console.error(chalk.gray('\nTip: production is the usual default, but any environment can stand alone — pick whichever you want this project to start with.'));
        process.exit(1);
    }

    // Apply default: if production already exists and the user didn't pass -e,
    // use 'dev' — this preserves existing behavior for mature projects.
    // `let`, not `const`: a free-plan 422 (plan_limit_reached/multi_env) on the
    // env-project auto-create below can fall the deploy back to production.
    let environment = explicitEnv ?? 'dev';

    let envLabel = environment !== 'production' ? ` (${environment})` : '';
    console.log(chalk.blue(`Deploying to project "${projectName}"${envLabel}...`));
    console.log(chalk.gray(`Source: ${sourceDir}`));

    // Validate project structure before deploying
    console.log(chalk.gray('Validating project structure...'));
    const validation = validateProject(sourceDir);

    // Parse solidactions.yaml for env config
    const solidactionsPath = path.join(sourceDir, 'solidactions.yaml');
    let yamlConfig: SolidActionsConfig | null = null;
    try {
        const configContent = fs.readFileSync(solidactionsPath, 'utf8');
        yamlConfig = yaml.load(configContent) as SolidActionsConfig;
    } catch {
        // Config parsing errors are handled by validateProject
    }

    if (validation.warnings.length > 0) {
        for (const warning of validation.warnings) {
            console.log(chalk.yellow(`⚠ ${warning}`));
        }
    }

    if (!validation.valid) {
        console.error(chalk.red('\nDeployment failed - validation errors:\n'));
        for (const error of validation.errors) {
            console.error(chalk.red(`  ✗ ${error}`));
        }
        console.error('');
        process.exit(1);
    }

    console.log(chalk.green('✓ Project structure validated'));

    // Check if the target environment's project record exists; create if needed.
    // For production deploys where we already confirmed existence above, reuse
    // the cached slug to avoid a duplicate GET.
    let projectSlug = projectName;
    try {
        if (environment === 'production' && productionExists === true && productionSlug !== null) {
            // Already confirmed — skip the re-lookup.
            projectSlug = productionSlug;
        } else {
            // For non-production environments, append the environment to the slug for lookup
            const lookupSlug = environment === 'production'
                ? projectName
                : `${projectName}-${environment}`;

            const checkResponse = await axios.get(`${config.host}/api/v1/projects/${lookupSlug}`, {
                headers: getApiHeaders(config),
            });
            projectSlug = checkResponse.data.slug || checkResponse.data.name;
        }
    } catch (error: any) {
        if (error.response?.status === 404) {
            // For non-production environments, require --create or give a clear hint.
            // Only print the workspace-mismatch warning on this abort path — not on
            // the success/create path (shouldPrintWorkspaceMismatch guards this).
            if (shouldPrintWorkspaceMismatch(environment, options.create ?? false)) {
                printWorkspaceMismatchOnce(error);
                console.error(chalk.red(`\nProject "${projectName}" doesn't have a ${environment} environment.\n`));
                console.error(`  If production is the intended target:`);
                console.error(`    solidactions project deploy ${projectName} <path> -e production`);
                console.error('');
                console.error(`  If you really want a new ${environment} environment:`);
                console.error(`    solidactions project deploy ${projectName} <path> -e ${environment} --create`);
                process.exit(1);
            }

            console.log(chalk.yellow(`Project "${projectName}"${envLabel} not found. Creating...`));
            try {
                projectSlug = await createEnvironmentProject(config, projectName, environment);
                console.log(chalk.green(`Project "${projectName}"${envLabel} created.`));
            } catch (createError: any) {
                if (isPlanLimitReachedError(createError)) {
                    // Free-plan tenant hit the multi_env gate. handlePlanLimitReached()
                    // exits(1) on every path except a confirmed fallback to production.
                    projectSlug = await handlePlanLimitReached(config, projectName, createError, productionExists, productionSlug);
                    environment = 'production';
                    envLabel = '';
                    console.log(chalk.blue(`Deploying to project "${projectName}" (production) instead.`));
                } else {
                    console.error(chalk.red('Failed to create project:'), createError.response?.data?.message || createError.message);
                    process.exit(1);
                }
            }
        } else {
            console.error(chalk.red('Failed to check project:'), error.response?.data?.message || error.message);
            process.exit(1);
        }
    }

    // --config-only: sync YAML env declarations without building
    if (options.configOnly) {
        if (!yamlConfig) {
            console.error(chalk.red('Cannot sync config: solidactions.yaml not found or invalid.'));
            process.exit(1);
        }

        await pushYamlDeclarations(config, projectSlug, yamlConfig);
        console.log(chalk.green(`✓ Config synced for ${projectSlug}${envLabel}`));
        return;
    }

    const archivePath = path.join(sourceDir, '.steps-deploy.tar.gz');

    // Plan the file list BEFORE creating the archive write stream so a walk error
    // (permission error, unreadable dir) aborts cleanly with no orphan tarball.
    let plan: ReturnType<typeof planDeployFiles>;
    try {
        plan = planDeployFiles(sourceDir, yamlConfig);
    } catch (error: any) {
        console.error(chalk.red('Deployment failed:'));
        console.error(error.message);
        process.exit(1);
    }

    // Summary line so silent truncation never reads as "shipped everything".
    const parts: string[] = ['.env excluded'];
    if (plan.summary.gitignoreApplied) {
        parts.push('.gitignore applied');
    }
    if (plan.summary.excludeRuleCount > 0) {
        parts.push(`${plan.summary.excludeRuleCount} exclude rule${plan.summary.excludeRuleCount === 1 ? '' : 's'}`);
    }
    console.log(chalk.gray(`Bundling ${plan.files.length} files (${parts.join('; ')})`));

    if (plan.summary.symlinksSkipped.length > 0) {
        console.log(chalk.yellow(`⚠ Skipped ${plan.summary.symlinksSkipped.length} symlink(s) (not followed): ${plan.summary.symlinksSkipped.join(', ')}`));
    }

    const output = fs.createWriteStream(archivePath);
    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 9 } });

    output.on('close', async () => {
        console.log(chalk.gray(`Archived ${archive.pointer()} total bytes`));

        try {
            const form = new FormData();
            form.append('source', fs.createReadStream(archivePath));

            console.log(chalk.yellow('Uploading...'));
            if (process.env.SOLIDACTIONS_DEPLOY_DEBUG === '1') {
                process.stderr.write(`[deploy-debug] POST ${config.host}/api/v1/projects/${projectSlug}/deploy (workspace=${config.workspaceId ?? '(none)'})\n`);
            }

            await axios.post(`${config.host}/api/v1/projects/${projectSlug}/deploy`, form, {
                headers: {
                    ...form.getHeaders(),
                    ...getApiHeaders(config),
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            console.log(chalk.green('Deployment successfully queued!'));
            console.log(chalk.yellow('Waiting for build to complete...\n'));
            if (process.env.SOLIDACTIONS_DEPLOY_DEBUG === '1') {
                process.stderr.write(`[deploy-debug] poll URL = ${config.host}/api/v1/projects/${projectSlug} (workspace=${config.workspaceId ?? '(none)'})\n`);
            }

            // Poll for completion
            let attempts = 0;
            const maxAttempts = 600; // 10 minutes of inactivity timeout
            let lastLogLength = 0;

            const poll = setInterval(async () => {
                try {
                    attempts++;
                    const statusRes = await axios.get(`${config.host}/api/v1/projects/${projectSlug}`, {
                        headers: getApiHeaders(config),
                    });
                    const { status, build_log } = statusRes.data;

                    // Stream new log content
                    if (build_log && build_log.length > lastLogLength) {
                        const newContent = build_log.substring(lastLogLength);
                        process.stdout.write(chalk.gray(newContent));
                        if (!newContent.endsWith('\n')) {
                            process.stdout.write('\n');
                        }
                        lastLogLength = build_log.length;
                        attempts = 0; // Reset timeout — build is still progressing
                    }

                    // Periodic waiting indicator when no logs yet
                    if (attempts > 0 && attempts % 15 === 0 && lastLogLength === 0) {
                        console.log(chalk.gray('Still waiting for build to start...'));
                    }

                    if (status === 'deployed') {
                        clearInterval(poll);
                        console.log(chalk.green(`\n✓ Deployed to ${projectSlug}${envLabel}!`));

                        // Always sync YAML declarations (registers variables and their mappings)
                        if (yamlConfig) {
                            await pushYamlDeclarations(config, projectSlug, yamlConfig);
                        }

                        if (yamlConfig && shouldPrintWebhookSecretNotice(yamlConfig.workflows ?? [])) {
                            const envFlag = environment !== 'dev' ? ` -e ${environment}` : '';
                            console.log('');
                            console.log(chalk.blue(`ℹ  Webhook secret: run \`solidactions webhook secret ${projectName}${envFlag}\` to retrieve the generated secret.`));
                            console.log(chalk.gray(`   Set the same value in your sender (e.g. Telegram setWebhook secret_token).`));
                        }

                        fs.unlinkSync(archivePath);
                        process.exit(0);
                    } else if (status === 'error') {
                        clearInterval(poll);
                        console.error(chalk.red('\n✗ Build Failed!'));
                        if (build_log) {
                            console.log(chalk.yellow('\n--- Full Build Log ---'));
                            console.log(chalk.gray(build_log));
                            console.log(chalk.yellow('--- End Build Log ---\n'));
                        }
                        fs.unlinkSync(archivePath);
                        process.exit(1);
                    } else if (attempts >= maxAttempts) {
                        clearInterval(poll);
                        console.error(chalk.red('\nTimeout waiting for build. It might still finish.'));
                        fs.unlinkSync(archivePath);
                        process.exit(1);
                    }
                } catch {
                    // Ignore transient errors
                }
            }, 1000);

        } catch (error: any) {
            console.error(chalk.red('Deployment failed:'));
            if (error.response) {
                if (error.response.status === 404) {
                    console.error("Project not found.");
                } else {
                    console.error(error.response.status, JSON.stringify(error.response.data, null, 2));
                }
            } else {
                console.error(error.message);
            }
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
            process.exit(1);
        }
    });

    archive.on('error', (err) => {
        throw err;
    });

    archive.pipe(output);

    // User code goes under tenantcode/ so it never conflicts with our Dockerfile.
    // Add each planned file explicitly (per-file walk computed above).
    for (const relPosixPath of plan.files) {
        const absPath = path.join(sourceDir, relPosixPath);
        archive.file(absPath, { name: 'tenantcode/' + relPosixPath });
    }

    // Dockerfile always at archive root, referencing tenantcode/
    const universalDockerfile = [
        'FROM node:24-alpine',
        'WORKDIR /app',
        'COPY tenantcode/package.json tenantcode/package-lock.json* ./',
        'RUN npm install',
        'COPY tenantcode/ .',
        'RUN npm run build',
    ].join('\n') + '\n';

    archive.append(universalDockerfile, { name: 'Dockerfile' });

    // --no-cache / --force-rebuild: inject a unique random-content file so all
    // cache layers (Blaxel content hash, S3 context.tar MD5, BuildKit COPY .)
    // see a new directory fingerprint and are forced to rebuild from scratch.
    const buster = cacheBusterEntry(options.noCache ?? false);
    if (buster) {
        console.log(chalk.yellow('🔄 --no-cache: injecting cache-buster, forcing a fresh build'));
        archive.append(buster.content, { name: buster.name });
    }

    await archive.finalize();
}

/**
 * Returns true if any workflow in the project has a webhook trigger that
 * uses HMAC or header authentication (i.e. requires a shared secret).
 * Used to gate the post-deploy notice pointing authors to `webhook secret`.
 */
export function shouldPrintWebhookSecretNotice(
    workflows: { trigger?: string; webhook?: { auth?: string } }[]
): boolean {
    return workflows.some(wf => {
        if (wf.trigger !== 'webhook') {
            return false;
        }
        const auth = wf.webhook?.auth ?? 'hmac';
        return auth === 'hmac' || auth === 'header';
    });
}
