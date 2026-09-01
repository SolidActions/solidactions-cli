import fs from 'fs';
import https from 'https';
import path from 'path';

const cacheFile = process.argv[2];
const registryUrl = 'https://registry.npmjs.org/@solidactions%2Fcli/latest';

function writeCache(latestVersion: string): void {
    const dir = path.dirname(cacheFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tempFile = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify({ checkedAt: new Date().toISOString(), latestVersion })}\n`, { mode: 0o600 });
    fs.renameSync(tempFile, cacheFile);
}

if (cacheFile) {
    const request = https.get(registryUrl, {
        headers: { accept: 'application/json', 'user-agent': '@solidactions/cli update check' },
        timeout: 5_000,
    }, (response) => {
        if (response.statusCode !== 200) {
            response.resume();
            return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
            if (body.length <= 64 * 1024) body += chunk;
        });
        response.on('end', () => {
            try {
                const version = JSON.parse(body)?.version;
                if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
                    writeCache(version);
                }
            } catch {
                // Offline, malformed, and unwritable-cache failures are silent.
            }
        });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => undefined);
}
