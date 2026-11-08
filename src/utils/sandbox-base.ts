import fs from 'fs';
import path from 'path';

export interface SandboxBase {
    source_hash: string | null;
    slug: string;
    restored_at: string;
}

export const SANDBOX_BASE_PATH = path.join('.solidactions', 'base.json');

export function isAppSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SOLIDACTIONS_APP_SANDBOX === '1';
}

export function readSandboxBase(dir: string): SandboxBase | null {
    try {
        const base: unknown = JSON.parse(fs.readFileSync(path.join(dir, SANDBOX_BASE_PATH), 'utf8'));
        if (base === null || typeof base !== 'object' || Array.isArray(base)) return null;
        const candidate = base as Record<string, unknown>;
        if (candidate.source_hash !== null && (typeof candidate.source_hash !== 'string' || !/^[a-f0-9]{32}$/i.test(candidate.source_hash))) return null;
        if (typeof candidate.slug !== 'string' || candidate.slug.length === 0 || typeof candidate.restored_at !== 'string' || candidate.restored_at.length === 0) return null;
        return { source_hash: candidate.source_hash, slug: candidate.slug, restored_at: candidate.restored_at };
    } catch {
        return null;
    }
}

export function writeSandboxBase(dir: string, base: SandboxBase): void {
    const target = path.join(dir, SANDBOX_BASE_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(base));
}

export function baseWireValue(base: SandboxBase): string {
    return base.source_hash ?? 'none';
}
