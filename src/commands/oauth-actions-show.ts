import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface OAuthActionsShowOptions {
    json?: boolean;
}

interface IoSchema {
    inputSchema?: { description?: string; properties?: Record<string, any>; required?: string[] };
    outputSchema?: { description?: string };
    ioExample?: {
        input?: {
            body?: any;
            headers?: Record<string, string>;
            path?: Record<string, string>;
            query?: Record<string, string>;
        };
        output?: any;
    };
}

interface OAuthActionDetail {
    platform: string;
    method: string;
    path: string;
    title: string;
    action_id: string;
    tags?: string[];
    io_schema?: IoSchema;
}

export async function oauthActionsShow(platform: string, actionId: string, options: OAuthActionsShowOptions) {
    const config = await requireConfigWithWorkspace();

    try {
        const response = await axios.get(`${config.host}/api/v1/oauth-actions/${platform}/${encodeURIComponent(actionId)}`, {
            headers: getApiHeaders(config),
        });

        const action: OAuthActionDetail = response.data.oauth_action;

        if (options.json) {
            process.stdout.write(JSON.stringify(action, null, 2) + '\n');
            return;
        }

        renderHumanReadable(action);
    } catch (error: any) {
        if (error.response?.status === 404) {
            console.error(chalk.red(`Action not found: ${platform}/${actionId}`));
        } else if (error.response?.status === 401) {
            console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>".'));
        } else if (error.response) {
            console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

function renderHumanReadable(action: OAuthActionDetail) {
    const method = (action.method || 'GET').toUpperCase();
    const ioSchema = action.io_schema || {};
    const example = ioSchema.ioExample?.input;

    console.log(chalk.bold(action.title));
    console.log(chalk.cyan(`${method} ${action.path}`));
    console.log(chalk.gray(`action_id: ${action.action_id}`));
    if (action.tags?.length) console.log(chalk.gray(`tags: ${action.tags.join(', ')}`));
    console.log('');

    const inputDesc = ioSchema.inputSchema?.description;
    if (inputDesc) {
        console.log(chalk.bold('Description:'));
        console.log(indent(inputDesc));
        console.log('');
    }

    if (example?.path && Object.keys(example.path).length) {
        console.log(chalk.bold('Path parameters (example values):'));
        console.log(chalk.gray(indent(JSON.stringify(example.path, null, 2))));
        console.log('');
    }
    if (example?.query && Object.keys(example.query).length) {
        console.log(chalk.bold('Query parameters (example values):'));
        console.log(chalk.gray(indent(JSON.stringify(example.query, null, 2))));
        console.log('');
    }
    if (example?.body !== undefined && example.body !== null) {
        console.log(chalk.bold('Example request body:'));
        console.log(chalk.gray(indent(JSON.stringify(example.body, null, 2))));
        console.log('');
    }
    if (ioSchema.ioExample?.output !== undefined) {
        console.log(chalk.bold('Example response:'));
        console.log(chalk.gray(indent(JSON.stringify(ioSchema.ioExample.output, null, 2))));
        console.log('');
    }

    console.log(chalk.bold('Paste-ready snippet:'));
    console.log(chalk.gray(indent(buildSnippet(action))));
}

/**
 * Render a fetch() call against the SA proxy with `{{name}}` path placeholders
 * rewritten to `${name}` template-literal slots, query parameters appended,
 * and the example body inlined verbatim (so the AI substitutes values into the
 * known-good shape rather than inferring it from JSON Schema).
 */
function buildSnippet(action: OAuthActionDetail): string {
    const method = (action.method || 'GET').toUpperCase();
    const platform = action.platform;
    const platformEnv = platform.toUpperCase().replace(/-/g, '_');
    const example = action.io_schema?.ioExample?.input;

    const pathTemplate = (action.path || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, name) => '${' + name.trim() + '}');

    const queryEntries = example?.query ? Object.entries(example.query) : [];
    const queryString = queryEntries.length
        ? '?' + queryEntries.flatMap(([k, v]) => {
            const encodedKey = encodeURIComponent(k);
            const items = Array.isArray(v) ? v : [v];
            return items.map((item) => `${encodedKey}=\${encodeURIComponent(${JSON.stringify(item)})}`);
        }).join('&')
        : '';

    const proxyHeaders: Record<string, string> = {
        'Authorization': '__PROXY_AUTH__',
        'X-SA-Connection': '__SA_CONNECTION__',
    };
    const exampleHeaders = example?.headers || {};
    for (const [k, v] of Object.entries(exampleHeaders)) {
        if (isProxyManagedHeader(k)) continue;
        proxyHeaders[k] = v;
    }
    if (example?.body !== undefined && example.body !== null && !proxyHeaders['Content-Type']) {
        proxyHeaders['Content-Type'] = 'application/json';
    }

    const headersBlock = Object.entries(proxyHeaders)
        .map(([k, v]) => {
            if (v === '__PROXY_AUTH__') return `      'Authorization': \`Bearer \${process.env.SA_PROXY_TOKEN}\`,`;
            if (v === '__SA_CONNECTION__') return `      'X-SA-Connection': process.env.${platformEnv},`;
            return `      ${JSON.stringify(k)}: ${JSON.stringify(v)},`;
        })
        .join('\n');

    const lines: string[] = [];
    lines.push('const res = await fetch(');
    lines.push(`  \`\${process.env.SA_PROXY_URL}/${platform}${pathTemplate}${queryString}\`,`);
    lines.push('  {');
    lines.push(`    method: '${method}',`);
    lines.push('    headers: {');
    lines.push(headersBlock);
    lines.push('    },');
    if (example?.body !== undefined && example.body !== null) {
        const bodyJson = JSON.stringify(example.body, null, 2)
            .split('\n')
            .map((l, i) => (i === 0 ? l : '    ' + l))
            .join('\n');
        if (typeof example.body === 'object' && example.body !== null && 'connectionKey' in example.body) {
            lines.push(`    // connectionKey: copy verbatim — the proxy rewrites it server-side from your X-SA-Connection header.`);
        }
        lines.push(`    body: JSON.stringify(${bodyJson}),`);
    }
    lines.push('  }');
    lines.push(');');
    lines.push('const data = await res.json();');
    return lines.join('\n');
}

function indent(text: string, prefix = '  '): string {
    return text.split('\n').map(line => prefix + line).join('\n');
}

/**
 * Defense-in-depth: even though the SAA API sanitizes `Authorization`,
 * `x-pica-*`, and `x-one-*` out of `ioExample.input.headers` before serving,
 * filter them again here so any future drift can't leak Pica internals into
 * a workflow's outbound request.
 */
function isProxyManagedHeader(name: string): boolean {
    const lower = name.toLowerCase();
    return lower === 'authorization'
        || lower.startsWith('x-pica-')
        || lower.startsWith('x-one-');
}
