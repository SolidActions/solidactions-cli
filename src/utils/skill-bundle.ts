/**
 * Normalization of a skills.read / roles.read_skill bundle into the pieces the
 * host-cache needs, plus binary reference fetching.
 *
 * Binary reference values arrive as {binary, mime, size, blob_sha} metadata —
 * bytes come from a separate read_reference_file call which returns EITHER a
 * JSON text block {signed_url,...} (non-image or large) OR an MCP image block
 * (base64) for small images. fetchBinaryReference handles both.
 */
import axios from 'axios';
import path from 'path';
import yaml from 'js-yaml';
import { Config } from './config';
import { callCrewsToolContent } from './mcp';
import { ArtifactIdentity, artifactIdentity } from './skill-cache';

export function reconstructSkillMd(properties: Record<string, unknown>, body: string | undefined): string {
    const { type: _type, name: propName, description: propDescription, ...extraProps } = properties;
    const frontmatterObj: Record<string, unknown> = {
        name: propName,
        description: propDescription,
        ...extraProps,
    };
    const yamlBlock = yaml.dump(frontmatterObj, { lineWidth: -1 });
    const bodyText = body ?? '';
    return `---\n${yamlBlock}---\n${bodyText.startsWith('\n') ? bodyText : '\n' + bodyText}`;
}

export interface BinaryRef {
    blobSha: string;
    mime: string;
    size: number;
}

export interface SkillBundle {
    identifier: string;
    properties: Record<string, unknown>;
    skillMd: string;
    textFiles: Record<string, string>;
    binaryFiles: Record<string, BinaryRef>;
    identity: ArtifactIdentity;
    storageScope: 'crew' | 'workspace' | null;
    skippedUnsafe: string[];
}

function readStorageScopeProp(properties: Record<string, unknown>): 'crew' | 'workspace' | null {
    const nested = (properties.storage as Record<string, unknown> | undefined)?.scope;
    const flat = properties['storage.scope'];
    const scope = nested ?? flat ?? null;
    return scope === 'crew' || scope === 'workspace' ? scope : null;
}

/** True when a reference key would escape the cache dir (same guards as skill pull). */
function isUnsafeReferenceKey(key: string): boolean {
    if (path.isAbsolute(key)) return true;
    const root = path.resolve('/probe-root');
    return !path.resolve(root, key).startsWith(root + path.sep);
}

export function normalizeBundle(data: any): SkillBundle {
    const properties = (data.properties ?? {}) as Record<string, unknown>;
    const textFiles: Record<string, string> = {};
    const binaryFiles: Record<string, BinaryRef> = {};
    const skippedUnsafe: string[] = [];

    for (const [key, value] of Object.entries((data.reference ?? {}) as Record<string, unknown>)) {
        if (isUnsafeReferenceKey(key)) {
            skippedUnsafe.push(key);
            continue;
        }
        if (typeof value === 'string') {
            textFiles[key] = value;
        } else if (value && typeof value === 'object' && (value as any).binary === true) {
            const v = value as any;
            binaryFiles[key] = { blobSha: v.blob_sha, mime: v.mime, size: v.size };
        }
        // else: unreachable — the server wire contract has exactly two reference
        // shapes, string | {binary:true,...} (see ResolvedReference::toWireValue).
    }

    return {
        identifier: data.identifier,
        properties,
        skillMd: reconstructSkillMd(properties, data.body),
        textFiles,
        binaryFiles,
        identity: artifactIdentity(data),
        storageScope: readStorageScopeProp(properties),
        skippedUnsafe,
    };
}

export async function fetchBinaryReference(
    config: Config,
    tool: 'skills' | 'roles',
    locator: Record<string, unknown>,
    refPath: string,
): Promise<Buffer> {
    const result = await callCrewsToolContent(config, tool, {
        action: 'read_reference_file',
        ...locator,
        path: refPath,
    });

    if (!result.ok) {
        const text = result.content?.[0]?.text ?? '';
        throw new Error(`failed to fetch binary reference '${refPath}': ${text}`);
    }

    for (const block of result.content) {
        if (block?.type === 'image' && typeof block.data === 'string') {
            return Buffer.from(block.data, 'base64');
        }
        if (block?.type === 'text' && typeof block.text === 'string') {
            let parsed: any;
            try {
                parsed = JSON.parse(block.text);
            } catch {
                continue;
            }
            if (parsed?.signed_url) {
                const response = await axios.get(parsed.signed_url, { responseType: 'arraybuffer' });
                return Buffer.from(response.data);
            }
        }
    }

    throw new Error(`failed to fetch binary reference '${refPath}': unrecognized response shape`);
}
