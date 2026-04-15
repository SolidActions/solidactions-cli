// src/utils/config.ts
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface Config {
    host: string;
    apiKey: string;
    workspaceId?: string;
}

export type ConfigSource = 'env' | string | null;

export interface ResolvedConfig {
    config: Config;
    sources: {
        host: ConfigSource;
        apiKey: ConfigSource;
        workspaceId: ConfigSource;
    };
    activePath: string; // path write-mutating commands should target
}

const GLOBAL_DIR = path.join(os.homedir(), '.solidactions');
const GLOBAL_FILE = path.join(GLOBAL_DIR, 'config.json');
const LOCAL_DIR_NAME = '.solidactions';
const LOCAL_FILE_NAME = 'config.json';

export function getGlobalConfigPath(): string {
    return GLOBAL_FILE;
}

export function getLocalConfigPath(cwd: string = process.cwd()): string {
    return path.join(cwd, LOCAL_DIR_NAME, LOCAL_FILE_NAME);
}
