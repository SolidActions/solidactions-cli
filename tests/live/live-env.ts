import { Config } from '../../src/utils/config';

export function liveConfig(): Config | null {
    const host = process.env.SOLIDACTIONS_LIVE_HOST;
    const apiKey = process.env.SOLIDACTIONS_LIVE_API_KEY;
    const workspaceId = process.env.SOLIDACTIONS_LIVE_WORKSPACE_ID;
    if (!host || !apiKey || !workspaceId) return null;
    return { host, apiKey, workspaceId };
}

export const LIVE = liveConfig() !== null;
