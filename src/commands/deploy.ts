import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import axios from 'axios';
import FormData from 'form-data';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { getConfig } from './init';

interface WorkflowConfig {
    id?: string;
    name: string;
    command?: string;
    file?: string;
    enabled?: boolean;
}

/**
 * Parsed environment variable declaration from YAML.
 * New format examples:
 *   - TEST_ENV_VAR                    -> { key: "TEST_ENV_VAR", mappedTo: null }
 *   - MAPPED_SECRET: JIMBO            -> { key: "MAPPED_SECRET", mappedTo: "JIMBO" }
 *   - DATABASE_URL: DATABASE_URL      -> { key: "DATABASE_URL", mappedTo: "DATABASE_URL" }
 */
interface ParsedEnvVar {
    key: string;
    mappedTo: string | null;
}

interface SolidActionsConfig {
    workflows: WorkflowConfig[];
    // New format: deployEnv at top level, env is a simple list
    deployEnv?: boolean;
    env?: (string | { [key: string]: string })[];
}

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
 * Parse a .env file into a key-value map.
 */
function parseEnvFile(filePath: string): Map<string, string> {
    const envMap = new Map<string, string>();

    if (!fs.existsSync(filePath)) {
        return envMap;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const equalsIndex = trimmed.indexOf('=');
        if (equalsIndex === -1) {
            continue;
        }

        const key = trimmed.substring(0, equalsIndex).trim();
        let value = trimmed.substring(equalsIndex + 1).trim();

        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        envMap.set(key, value);
    }

    return envMap;
}

/**
 * Parse YAML env declarations into structured format.
 * Handles the new simplified format:
 *   - VAR_NAME           -> { key: "VAR_NAME", mappedTo: null }
 *   - VAR_NAME: GLOBAL   -> { key: "VAR_NAME", mappedTo: "GLOBAL" }
 */
function parseYamlEnvVars(config: SolidActionsConfig): ParsedEnvVar[] {
    const parsedVars: ParsedEnvVar[] = [];

    if (!config.env || !Array.isArray(config.env)) {
        return parsedVars;
    }

    for (const item of config.env) {
        if (typeof item === 'string') {
            // Simple string: - VAR_NAME (declared only, needs configuration)
            parsedVars.push({ key: item, mappedTo: null });
        } else if (typeof item === 'object' && item !== null) {
            // Object: - VAR_NAME: GLOBAL_NAME (mapped to global)
            const keys = Object.keys(item);
            if (keys.length === 1) {
                const key = keys[0];
                const mappedTo = item[key];
                parsedVars.push({ key, mappedTo: mappedTo || null });
            }
        }
    }

    return parsedVars;
}

/**
 * Extract declared variable keys from solidactions.yaml env config.
 * Returns a set of env var keys that are declared in YAML.
 */
function getYamlDeclaredVars(config: SolidActionsConfig): Set<string> {
    const parsedVars = parseYamlEnvVars(config);
    return new Set(parsedVars.map(v => v.key));
}

/**
 * Check if deployEnv is enabled in the config.
 * New format has deployEnv at top level.
 */
function isDeployEnvEnabled(config: SolidActionsConfig): boolean {
    return config.deployEnv === true;
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
    host: string,
    apiKey: string,
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
        source: 'yaml' as const,
    }));

    try {
        await axios.post(
            `${host}/api/v1/projects/${projectSlug}/variable-mappings/sync-yaml`,
            { declarations },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            }
        );
        console.log(chalk.gray(`Synced ${declarations.length} YAML env declarations`));
    } catch (error: any) {
        console.error(chalk.yellow('Warning: Failed to sync YAML declarations:'), error.response?.data?.message || error.message);
    }
}

/**
 * Push environment variables from .env file to project.
 * Only pushes vars that are declared in solidactions.yaml.
 */
async function pushEnvVars(
    host: string,
    apiKey: string,
    projectSlug: string,
    sourceDir: string,
    environment: string,
    yamlConfig: SolidActionsConfig
): Promise<void> {
    // Get vars declared in YAML
    const declaredVars = getYamlDeclaredVars(yamlConfig);
    if (declaredVars.size === 0) {
        console.log(chalk.gray('No environment variables declared in solidactions.yaml'));
        return;
    }

    // Read the .env file for this environment
    const envFileName = environment === 'production' ? '.env' : `.env.${environment}`;
    const envFilePath = path.join(sourceDir, envFileName);

    if (!fs.existsSync(envFilePath)) {
        console.log(chalk.yellow(`⚠ ${envFileName} not found, skipping env push`));
        // Warn about each missing declared var
        for (const key of declaredVars) {
            console.log(chalk.yellow(`  ⚠ ${key}: no value (not in ${envFileName})`));
        }
        return;
    }

    // Parse the .env file
    const envValues = parseEnvFile(envFilePath);

    // Filter to only YAML-declared vars
    const variables: { key: string; value: string; is_secret: boolean }[] = [];
    const missing: string[] = [];

    for (const key of declaredVars) {
        const value = envValues.get(key);
        if (value !== undefined) {
            // Mark vars containing "secret", "key", "token", "password" as secrets
            const isSecret = /secret|key|token|password|credential/i.test(key);
            variables.push({ key, value, is_secret: isSecret });
        } else {
            missing.push(key);
        }
    }

    // Warn about missing vars
    for (const key of missing) {
        console.log(chalk.yellow(`⚠ ${key}: not found in ${envFileName}`));
    }

    if (variables.length === 0) {
        console.log(chalk.yellow('No matching environment variables to push'));
        return;
    }

    // Push to API
    try {
        const response = await axios.post(
            `${host}/api/v1/projects/${projectSlug}/variable-mappings/bulk`,
            { variables },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            }
        );

        const { created, updated } = response.data;
        console.log(chalk.green(`✓ Pushed ${variables.length} environment variables from ${envFileName}`));
        if (created > 0 || updated > 0) {
            console.log(chalk.gray(`  (${created} created, ${updated} updated)`));
        }
    } catch (error: any) {
        console.error(chalk.red('Failed to push environment variables:'), error.response?.data?.message || error.message);
    }
}

export async function deploy(projectName: string, sourcePath?: string, options: DeployOptions = {}) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run `solidactions init <api-key>` first.'));
        process.exit(1);
    }

    const sourceDir = sourcePath ? path.resolve(sourcePath) : process.cwd();
    const environment = options.env || 'production';

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
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
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
                    headers: {
                        'Authorization': `Bearer ${config.apiKey}`,
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                    },
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

    const zipPath = path.join(sourceDir, '.steps-deploy.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', async () => {
        console.log(chalk.gray(`Zipped ${archive.pointer()} total bytes`));

        try {
            const form = new FormData();
            form.append('source', fs.createReadStream(zipPath));

            console.log(chalk.yellow('Uploading...'));

            await axios.post(`${config.host}/api/v1/projects/${projectSlug}/deploy`, form, {
                headers: {
                    ...form.getHeaders(),
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`,
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            console.log(chalk.green('Deployment successfully queued!'));
            console.log(chalk.yellow('Waiting for build to complete...\n'));

            // Poll for completion
            let attempts = 0;
            const maxAttempts = 120; // 2 minutes timeout
            let lastLogLength = 0;

            const poll = setInterval(async () => {
                try {
                    attempts++;
                    const statusRes = await axios.get(`${config.host}/api/v1/projects/${projectSlug}`, {
                        headers: { 'Authorization': `Bearer ${config.apiKey}` }
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
                    }

                    if (status === 'deployed') {
                        clearInterval(poll);
                        console.log(chalk.green(`\n✓ Deployed to ${projectSlug}${envLabel}!`));

                        // Always sync YAML declarations (registers env vars and their mappings)
                        if (yamlConfig) {
                            await pushYamlDeclarations(
                                config.host,
                                config.apiKey,
                                projectSlug,
                                yamlConfig
                            );
                        }

                        // Push .env values if deployEnv is enabled
                        if (yamlConfig && isDeployEnvEnabled(yamlConfig)) {
                            console.log(chalk.blue('\nPushing environment variables...'));
                            await pushEnvVars(
                                config.host,
                                config.apiKey,
                                projectSlug,
                                sourceDir,
                                environment,
                                yamlConfig
                            );
                        }

                        fs.unlinkSync(zipPath);
                        process.exit(0);
                    } else if (status === 'error') {
                        clearInterval(poll);
                        console.error(chalk.red('\n✗ Build Failed!'));
                        if (build_log) {
                            console.log(chalk.yellow('\n--- Full Build Log ---'));
                            console.log(chalk.gray(build_log));
                            console.log(chalk.yellow('--- End Build Log ---\n'));
                        }
                        fs.unlinkSync(zipPath);
                        process.exit(1);
                    } else if (attempts >= maxAttempts) {
                        clearInterval(poll);
                        console.error(chalk.red('\nTimeout waiting for build. It might still finish.'));
                        fs.unlinkSync(zipPath);
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
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            process.exit(1);
        }
    });

    archive.on('error', (err) => {
        throw err;
    });

    archive.pipe(output);

    // Glob patterns to ignore
    const ignore = ['node_modules/**', '.git/**', '.steps-deploy.zip', 'dist/**', 'vendor/**', '**/node_modules/**'];

    archive.glob('**/*', {
        cwd: sourceDir,
        ignore: ignore,
        dot: true
    });

    await archive.finalize();
}
