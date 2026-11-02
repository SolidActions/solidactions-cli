import { createTerminalGate } from './terminal-gate';

type BuildStatus = { status: string; build_log?: string };

type PollOptions = {
    read: () => Promise<BuildStatus>;
    schedule: (tick: () => Promise<void>) => () => void;
    maxAttempts: number;
    onLog: (content: string) => void;
    onWaiting: () => void;
    onDeployed: () => Promise<void>;
    onFailed: (log?: string) => void;
    onTimeout: () => void;
    finalize: (buildFailed: boolean) => Promise<void>;
};

export function startDeployStatusPoll(options: PollOptions): void {
    let attempts = 0;
    let lastLogLength = 0;
    let pollInFlight = false;
    const terminalGate = createTerminalGate();

    const stop = options.schedule(async () => {
        if (pollInFlight) return;
        pollInFlight = true;
        try {
            attempts++;
            const { status, build_log } = await options.read();
            if (build_log && build_log.length > lastLogLength) {
                options.onLog(build_log.substring(lastLogLength));
                lastLogLength = build_log.length;
                attempts = 0;
            }
            if (attempts > 0 && attempts % 15 === 0 && lastLogLength === 0) {
                options.onWaiting();
            }
            if (status === 'deployed') {
                if (!terminalGate.claim()) return;
                stop();
                await options.onDeployed();
                await options.finalize(false);
            } else if (status === 'error') {
                if (!terminalGate.claim()) return;
                stop();
                options.onFailed(build_log);
                await options.finalize(true);
            } else if (attempts >= options.maxAttempts) {
                if (!terminalGate.claim()) return;
                stop();
                options.onTimeout();
                await options.finalize(true);
            }
        } catch {
            // Ignore transient errors
        } finally {
            pollInFlight = false;
        }
    });
}
