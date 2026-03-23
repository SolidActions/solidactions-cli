import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import axios from 'axios';
import FormData from 'form-data';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { getConfig } from './init';
import { SolidActionsConfig, parseYamlEnvVars } from '../utils/env';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

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


interface DeployOptions {
    env?: string;
    create?: boolean;
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

export async function deploy(projectName: string, sourcePath?: string, options: DeployOptions = {}) {
    const config = await requireConfigWithWorkspace();

    const sourceDir = sourcePath ? path.resolve(sourcePath) : process.cwd();
    const environment = options.env || 'dev';

    if (!fs.existsSync(sourceDir)) {
        console.error(chalk.red(`Source directory not found: ${sourceDir}`));
        process.exit(1);
    }

    const envLabel = environment !== 'production' ? ` (${environment})` : '';
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

    // Check if project exists, create if not
    let projectSlug = projectName;
    try {
        // For non-production environments, append the environment to the slug for lookup
        const lookupSlug = environment === 'production'
            ? projectName
            : `${projectName}-${environment}`;

        const checkResponse = await axios.get(`${config.host}/api/v1/projects/${lookupSlug}`, {
            headers: getApiHeaders(config),
        });
        projectSlug = checkResponse.data.slug || checkResponse.data.name;
    } catch (error: any) {
        if (error.response?.status === 404) {
            // For non-production environments, check if we should create
            if (environment !== 'production' && !options.create) {
                console.log(chalk.yellow(`Project "${projectName}" doesn't have a ${environment} environment.`));
                console.log(chalk.gray('Use --create to create it, or deploy to production first.'));
                process.exit(1);
            }

            console.log(chalk.yellow(`Project "${projectName}"${envLabel} not found. Creating...`));
            try {
                const createResponse = await axios.post(`${config.host}/api/v1/projects`, {
                    name: projectName,
                    slug: projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-') + (environment !== 'production' ? `-${environment}` : ''),
                    environment: environment,
                }, {
                    headers: getApiHeaders(config, 'application/json'),
                });
                projectSlug = createResponse.data.slug || createResponse.data.name;
                console.log(chalk.green(`Project "${projectName}"${envLabel} created.`));
            } catch (createError: any) {
                console.error(chalk.red('Failed to create project:'), createError.response?.data?.message || createError.message);
                process.exit(1);
            }
        } else {
            console.error(chalk.red('Failed to check project:'), error.response?.data?.message || error.message);
            process.exit(1);
        }
    }

    const archivePath = path.join(sourceDir, '.steps-deploy.tar.gz');
    const output = fs.createWriteStream(archivePath);
    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 9 } });

    output.on('close', async () => {
        console.log(chalk.gray(`Archived ${archive.pointer()} total bytes`));

        try {
            const form = new FormData();
            form.append('source', fs.createReadStream(archivePath));

            console.log(chalk.yellow('Uploading...'));

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

                        // Always sync YAML declarations (registers env vars and their mappings)
                        if (yamlConfig) {
                            await pushYamlDeclarations(config, projectSlug, yamlConfig);
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

    // Glob patterns to ignore
    const ignore = ['node_modules/**', '.git/**', '.steps-deploy.tar.gz', '.steps-deploy.zip', 'dist/**', 'vendor/**', '**/node_modules/**'];

    // User code goes under tenantcode/ so it never conflicts with our Dockerfile
    archive.glob('**/*', {
        cwd: sourceDir,
        ignore: ignore,
        dot: true
    }, {
        prefix: 'tenantcode'
    });

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

    await archive.finalize();
}
