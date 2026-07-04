import { describe, expect, it } from 'vitest';
import { TEMPLATE_FILES } from '../src/commands/init';

describe('TEMPLATE_FILES', () => {
    it('includes package-lock.json so scaffolds get SDK pin protection', () => {
        expect(TEMPLATE_FILES.map(([remote]) => remote)).toContain('package-lock.json');
    });

    it('still includes the core scaffold files', () => {
        const remotes = TEMPLATE_FILES.map(([remote]) => remote);
        for (const f of ['package.json', 'tsconfig.json', 'solidactions.yaml', '.env.example', 'src/hello.ts']) {
            expect(remotes).toContain(f);
        }
    });
});
