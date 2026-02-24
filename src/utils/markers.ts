import fs from 'fs';
import path from 'path';
import fsExtra from 'fs-extra';

export function upsertMarkerSection(filePath: string, markerName: string, content: string): void {
    fsExtra.ensureDirSync(path.dirname(filePath));

    let existing = '';
    if (fs.existsSync(filePath)) {
        existing = fs.readFileSync(filePath, 'utf8');
    }

    const openTag = `<!-- ${markerName} -->`;
    const closeTag = `<!-- /${markerName} -->`;
    const block = `${openTag}\n${content}\n${closeTag}`;

    const openIdx = existing.indexOf(openTag);
    const closeIdx = existing.indexOf(closeTag);

    if (openIdx !== -1 && closeIdx !== -1) {
        const before = existing.substring(0, openIdx);
        const after = existing.substring(closeIdx + closeTag.length);
        fs.writeFileSync(filePath, before + block + after, 'utf8');
    } else {
        const result = existing.length > 0 ? existing + '\n\n' + block + '\n' : block + '\n';
        fs.writeFileSync(filePath, result, 'utf8');
    }
}

export function hasMarkerSection(filePath: string, markerName: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf8');
    return content.includes(`<!-- ${markerName} -->`) && content.includes(`<!-- /${markerName} -->`);
}

export function findAiHelperFile(): string | null {
    if (hasMarkerSection('CLAUDE.md', 'SolidActions')) return 'CLAUDE.md';
    if (hasMarkerSection('AGENTS.md', 'SolidActions')) return 'AGENTS.md';
    return null;
}
