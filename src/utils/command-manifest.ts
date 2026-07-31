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
    /**
     * Options declared on the program itself. Most (e.g. `-w, --workspace-override`)
     * apply to every command, but `--version` is a commander-root-only special
     * case: `solidactions --version` works, `solidactions project deploy --version`
     * does not.
     */
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

/**
 * commander auto-adds a `-h, --help` option to every command, but it is
 * synthesized at help-render time (see lib/help.js `visibleOptions`) rather
 * than being a real `Option` living in `command.options` — so the plain
 * `command.options.map(describeOption)` walk below silently drops it from
 * the manifest. Downstream doc validators need it (real prose documents
 * `--help`), so read the same private fields commander's own help renderer
 * reads (`_hasHelpOption`, `_helpFlags`, `_helpShortFlag`, `_helpLongFlag`,
 * `_helpDescription` — there is no public getter for any of them) and
 * synthesize an equivalent manifest entry by hand.
 */
function describeHelpOption(command: Command): ManifestOption | null {
    const cmd = command as unknown as {
        _hasHelpOption?: boolean;
        _helpFlags?: string;
        _helpShortFlag?: string;
        _helpLongFlag?: string;
        _helpDescription?: string;
    };
    if (cmd._hasHelpOption !== true) {
        return null;
    }
    const short = cmd._helpShortFlag ?? null;
    const long = cmd._helpLongFlag ?? null;
    if (!short && !long) {
        return null;
    }
    return {
        flags: cmd._helpFlags ?? [short, long].filter((flag): flag is string => flag !== null).join(', '),
        long,
        short,
        description: cmd._helpDescription ?? '',
        required: false,
        value_required: false,
        value_optional: false,
        variadic: false,
        negated: false,
        hidden: false,
    };
}

/**
 * commander adds an implicit `help [command]` (sub)command to any command
 * that has children, no action handler of its own, and no explicit `help`
 * command already registered (`_hasImplicitHelpCommand()` in command.js) —
 * but, like the `-h, --help` option above, it is synthesized at help-render
 * time (see `Help.visibleCommands` in lib/help.js) rather than living in
 * `command.commands`, so the recursive walk in `describeCommand` never sees
 * it. It is real and typable at every level it applies — both
 * `solidactions help project` and `solidactions project help view` work —
 * so downstream doc validators need an entry for it too. Reconstruct it the
 * same way commander's own help renderer does (there is no public API for
 * any of `_hasImplicitHelpCommand`, `_helpCommandnameAndArgs`,
 * `_helpCommandDescription`): build a throwaway `Command` from those private
 * fields, then run it through the normal `describeCommand` walk so its shape
 * (path, aliases, options via `describeHelpOption`, etc.) matches every
 * other command for free.
 */
function describeImplicitHelpCommand(command: Command, path: string[]): ManifestCommand[] {
    const cmd = command as unknown as {
        _hasImplicitHelpCommand?: () => boolean;
        _helpCommandnameAndArgs?: string;
        _helpCommandDescription?: string;
    };
    if (typeof cmd._hasImplicitHelpCommand !== 'function' || !cmd._hasImplicitHelpCommand()) {
        return [];
    }
    const nameAndArgs = cmd._helpCommandnameAndArgs ?? 'help [command]';
    const match = nameAndArgs.match(/([^ ]+) *(.*)/);
    const helpName = match?.[1] ?? 'help';
    const helpArgs = match?.[2] ?? '';
    // Same construction as commander's Help.visibleCommands: a fresh command
    // with its own help option turned off (commander never lists "-h, --help"
    // twice for the same invocation) and, when the nameAndArgs spec carries
    // one (e.g. "[command]"), the optional target-command argument.
    const helpCommand = command.createCommand(helpName).helpOption(false);
    helpCommand.description(cmd._helpCommandDescription ?? '');
    if (helpArgs) {
        helpCommand.arguments(helpArgs);
    }
    return describeCommand(helpCommand, path);
}

function describeCommand(command: Command, parentPath: string[]): ManifestCommand[] {
    const path = [...parentPath, command.name()];
    const options = command.options.map(describeOption);
    const helpOption = describeHelpOption(command);
    if (helpOption) {
        options.push(helpOption);
    }
    const entry: ManifestCommand = {
        path,
        name: command.name(),
        aliases: [...command.aliases()],
        description: command.description(),
        hidden: isHiddenCommand(command),
        arguments: command.registeredArguments.map(describeArgument),
        options,
    };
    return [
        entry,
        ...command.commands.flatMap((child) => describeCommand(child, path)),
        ...describeImplicitHelpCommand(command, path),
    ];
}

/**
 * Walk an assembled commander program into its manifest. Declaration order is
 * preserved throughout: it is already deterministic and mirrors help ordering.
 */
export function buildCommandManifest(program: Command, cliVersion: string): CommandManifest {
    // The root program's `-h, --help` is the same commander-synthesized
    // option as describeHelpOption handles per-command (see that function's
    // comment) — commander keeps it outside `program.options` too, so the
    // plain `program.options.map(describeOption)` walk below would otherwise
    // silently drop it from global_options even though `solidactions --help`
    // works (README.md documents it).
    const globalOptions = program.options.map(describeOption);
    const rootHelpOption = describeHelpOption(program);
    if (rootHelpOption) {
        globalOptions.push(rootHelpOption);
    }
    return {
        schema_version: COMMAND_MANIFEST_SCHEMA_VERSION,
        cli_name: program.name(),
        cli_version: cliVersion,
        global_options: globalOptions,
        commands: [
            ...program.commands.flatMap((command) => describeCommand(command, [])),
            ...describeImplicitHelpCommand(program, []),
        ],
    };
}
