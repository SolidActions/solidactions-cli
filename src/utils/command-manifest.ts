import type { Argument, Command, Option } from 'commander';

/**
 * Machine-readable description of the CLI's command surface, generated from the
 * commander definitions at build time (#1004 PR 0). Consumers — chiefly the
 * content repo's prose validator — pin a released manifest and fail CI when
 * documentation names a command or flag that does not exist here.
 *
 * Follows the `schema_version` precedent set by src/utils/skill-cache.ts.
 */
export const COMMAND_MANIFEST_SCHEMA_VERSION = 1;
export const COMMAND_MANIFEST_FILE = 'command-manifest.json';

export interface ManifestOption {
    /** The raw commander flags string, e.g. "-e, --env <environment>". */
    flags: string;
    /** Long form including leading dashes, e.g. "--env" or "--no-cache"; null if the option has none. */
    long: string | null;
    /** Short form including the leading dash, e.g. "-e"; null if the option has none. */
    short: string | null;
    description: string;
    /** Declared with .requiredOption() — the option itself must be supplied. */
    required: boolean;
    /** A value must follow the option, e.g. "--env <environment>". */
    value_required: boolean;
    /** A value may follow the option, e.g. "--env [environment]". */
    value_optional: boolean;
    variadic: boolean;
    /** A "--no-x" boolean. */
    negated: boolean;
    /** Declared with .hideHelp() — parses, but is not part of the public surface. */
    hidden: boolean;
    default?: unknown;
    default_description?: string;
    choices?: string[];
}

export interface ManifestArgument {
    name: string;
    required: boolean;
    variadic: boolean;
    description: string;
    default?: unknown;
    choices?: string[];
}

export interface ManifestCommand {
    /** Noun-verb path from the program root, e.g. ["crew", "env", "set"]. */
    path: string[];
    name: string;
    /** Alternate names accepted for this command, e.g. from .alias()/.aliases(); empty if none. */
    aliases: string[];
    description: string;
    /** Declared with { hidden: true } — parses, but is not part of the public surface. */
    hidden: boolean;
    arguments: ManifestArgument[];
    options: ManifestOption[];
}

export interface CommandManifest {
    schema_version: typeof COMMAND_MANIFEST_SCHEMA_VERSION;
    cli_name: string;
    cli_version: string;
    /** Options declared on the program itself; they apply to every command. */
    global_options: ManifestOption[];
    commands: ManifestCommand[];
}

/**
 * True when `value` survives JSON.stringify without becoming undefined —
 * functions, symbols and undefined do not, and must never reach the manifest.
 */
function isJsonSafe(value: unknown): boolean {
    try {
        return JSON.stringify(value) !== undefined;
    } catch {
        return false;
    }
}

function applyDefault(
    target: { default?: unknown; default_description?: string },
    defaultValue: unknown,
    defaultValueDescription: string | undefined,
): void {
    if (defaultValue === undefined) {
        if (defaultValueDescription !== undefined) {
            target.default_description = defaultValueDescription;
        }
        return;
    }
    if (isJsonSafe(defaultValue)) {
        target.default = defaultValue;
        if (defaultValueDescription !== undefined) {
            target.default_description = defaultValueDescription;
        }
        return;
    }
    target.default_description = defaultValueDescription ?? String(defaultValue);
}

function describeOption(option: Option): ManifestOption {
    const entry: ManifestOption = {
        flags: option.flags,
        long: option.long ?? null,
        short: option.short ?? null,
        description: option.description,
        required: option.mandatory === true,
        value_required: option.required === true,
        value_optional: option.optional === true,
        variadic: option.variadic === true,
        negated: option.negate === true,
        hidden: option.hidden === true,
    };
    applyDefault(entry, option.defaultValue, option.defaultValueDescription);
    if (option.argChoices) {
        entry.choices = [...option.argChoices];
    }
    return entry;
}

function describeArgument(argument: Argument): ManifestArgument {
    const entry: ManifestArgument = {
        name: argument.name(),
        required: argument.required === true,
        variadic: argument.variadic === true,
        description: argument.description,
    };
    applyDefault(entry, argument.defaultValue, argument.defaultValueDescription);
    if (argument.argChoices) {
        entry.choices = [...argument.argChoices];
    }
    return entry;
}

/**
 * commander exposes no public getter for a command hidden via
 * `.command(name, { hidden: true })` — the flag lives on the private `_hidden`
 * field, which its own help renderer reads. Read it the same way.
 */
function isHiddenCommand(command: Command): boolean {
    return (command as unknown as { _hidden?: boolean })._hidden === true;
}

function describeCommand(command: Command, parentPath: string[]): ManifestCommand[] {
    const path = [...parentPath, command.name()];
    const entry: ManifestCommand = {
        path,
        name: command.name(),
        aliases: [...command.aliases()],
        description: command.description(),
        hidden: isHiddenCommand(command),
        arguments: command.registeredArguments.map(describeArgument),
        options: command.options.map(describeOption),
    };
    return [entry, ...command.commands.flatMap((child) => describeCommand(child, path))];
}

/**
 * Walk an assembled commander program into its manifest. Declaration order is
 * preserved throughout: it is already deterministic and mirrors help ordering.
 */
export function buildCommandManifest(program: Command, cliVersion: string): CommandManifest {
    return {
        schema_version: COMMAND_MANIFEST_SCHEMA_VERSION,
        cli_name: program.name(),
        cli_version: cliVersion,
        global_options: program.options.map(describeOption),
        commands: program.commands.flatMap((command) => describeCommand(command, [])),
    };
}
