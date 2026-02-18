import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';

const CONFIG_DIR = path.join(os.homedir(), '.solidactions');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface Config {
    host: string;
    apiKey: string;
}

export function getConfig(): Config | null {
    if (!fs.existsSync(CONFIG_FILE)) {
        return null;
    }
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        // Handle legacy config format (token -> apiKey)
        if (config.token && !config.apiKey) {
            config.apiKey = config.token;
        }
        return config;
    } catch {
        return null;
    }
}

export function saveConfig(config: Config): void {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function clearConfig(): void {
    if (fs.existsSync(CONFIG_FILE)) {
        fs.unlinkSync(CONFIG_FILE);
    }
}

export async function init(apiKey: string, options: { dev?: boolean; host?: string }) {
    // Determine host
    let host: string;
    if (options.host) {
        host = options.host;
    } else if (options.dev) {
        host = 'http://localhost:8000';
    } else {
        host = 'https://solidactions.io';
    }

    // Validate API key format (should be a Sanctum token)
    if (!apiKey || apiKey.trim().length === 0) {
        console.error(chalk.red('Error: API key is required.'));
        console.log(chalk.gray('Generate an API key at: ') + chalk.blue(`${host}/settings/api-keys`));
        process.exit(1);
    }

    console.log(chalk.blue(`Initializing SolidActions CLI...`));
    console.log(chalk.gray(`Host: ${host}`));

    // Save the configuration
    saveConfig({
        host,
        apiKey: apiKey.trim(),
    });

    console.log(chalk.green('CLI initialized successfully!'));
    console.log(chalk.gray(`Configuration saved to ${CONFIG_FILE}`));
    console.log('');
    console.log(chalk.blue('Quick start:'));
    console.log(chalk.gray('  solidactions deploy <project-name>    Deploy current directory'));
    console.log(chalk.gray('  solidactions run <project> <workflow> Run a workflow'));
    console.log(chalk.gray('  solidactions runs                     List recent runs'));
}

export async function logout() {
    if (fs.existsSync(CONFIG_FILE)) {
        clearConfig();
        console.log(chalk.green('Logged out successfully.'));
    } else {
        console.log(chalk.gray('Not logged in.'));
    }
}

export async function whoami() {
    const config = getConfig();
    if (!config) {
        console.log(chalk.yellow('Not initialized.'));
        console.log(chalk.gray('Run "solidactions init <api-key>" to configure.'));
        process.exit(1);
    }

    console.log(chalk.blue('Current configuration:'));
    console.log(`  Host: ${config.host}`);
    console.log(`  API Key: ${config.apiKey.substring(0, 8)}...${config.apiKey.slice(-4)}`);
}
