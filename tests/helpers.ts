import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach } from 'vitest';

const ENV_KEYS_TO_RESTORE = [
    'HOME',
    'SOLIDACTIONS_HOST',
    'SOLIDACTIONS_API_KEY',
    'SOLIDACTIONS_WORKSPACE_ID',
];

export function makeTmpEnv(): { home: string; cwd: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-test-'));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'work');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    const saved: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS_TO_RESTORE) {
        saved[key] = process.env[key];
    }
    process.env.HOME = home;
    delete process.env.SOLIDACTIONS_HOST;
    delete process.env.SOLIDACTIONS_API_KEY;
    delete process.env.SOLIDACTIONS_WORKSPACE_ID;

    const cleanup = () => {
        for (const key of ENV_KEYS_TO_RESTORE) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        fs.rmSync(root, { recursive: true, force: true });
    };

    return { home, cwd, cleanup };
}

export function writeGlobal(home: string, body: object): string {
    const dir = path.join(home, '.solidactions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
}

export function writeLocal(cwd: string, body: object): string {
    const dir = path.join(cwd, '.solidactions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
}

export function withEachCleanup(state: { cleanup: (() => void) | null }) {
    afterEach(() => {
        state.cleanup?.();
        state.cleanup = null;
    });
}
