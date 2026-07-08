/**
 * solidactions skill exec <name> [--role <r>] [--environment <env>] -- <command...>
 *
 * Runs a command against the DEPLOYED skill in its real sandbox runtime via
 * the crews MCP exec_skill action — the post-push smoke step. Counterpart to
 * `skill run` (local). DELIBERATE DIVERGENCE from `skill run`: default
 * environment here is `production` (matches the server default — this is the
 * "verify deployed" step); `skill run` defaults to `dev` (a local dev loop).
 */
import chalk from 'chalk';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';

export interface SkillExecOptions {
    role?: string;
    inCrew?: string;
    environment?: string;
}

export async function skillExecWithConfig(
    name: string,
    commandParts: string[],
    options: SkillExecOptions,
    config: Config,
): Promise<void> {
    if (commandParts.length === 0) {
        process.stderr.write(chalk.red('error: no command given — usage: skill exec <name> -- <command...>\n'));
        process.exit(1);
    }
    const command = commandParts.join(' ');

    const isRole = Boolean(options.role);
    const tool = isRole ? 'roles' : 'skills';
    const args: Record<string, unknown> = isRole
        ? { action: 'exec_skill', role: options.role, name, command }
        : { action: 'exec_skill', identifier: name, command };
    if (options.environment) args.environment = options.environment;
    if (isRole && options.inCrew) args.in_crew = options.inCrew;

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

export async function skillExec(name: string, commandParts: string[], options: SkillExecOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await skillExecWithConfig(name, commandParts, options, config);
}
