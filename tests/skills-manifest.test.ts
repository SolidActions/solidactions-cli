import path from 'path';
import { describe, expect, it } from 'vitest';
import { SOLIDACTIONS_SKILL_NAMES, skillTargetDir } from '../src/utils/skills';

describe('SolidActions generated skill manifest', () => {
    it('pins every skill installed by init and ai init', () => {
        expect(SOLIDACTIONS_SKILL_NAMES).toEqual([
            'solidactions-getting-started',
            'solidactions-workflow-coding',
            'solidactions-deploy-and-config',
            'solidactions-oauth-actions',
            'solidactions-crew-skills',
        ]);
    });

    it('uses the documented Claude and cross-agent locations', () => {
        expect(skillTargetDir('CLAUDE.md', '/project')).toBe(path.join('/project', '.claude', 'skills'));
        expect(skillTargetDir('AGENTS.md', '/project')).toBe(path.join('/project', '.agents', 'skills'));
    });
});
