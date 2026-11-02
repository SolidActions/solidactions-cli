export function createTerminalGate(): { claim: () => boolean } {
    let claimed = false;

    return {
        claim: () => {
            if (claimed) return false;
            claimed = true;
            return true;
        },
    };
}
