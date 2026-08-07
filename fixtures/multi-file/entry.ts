/**
 * Multi-file fixture workflow: imports a sibling module using the NodeNext
 * .js-extension convention. This is the pattern that breaks under tsx's CJS
 * hook (require('./lib/double.js') cannot find the real double.ts file).
 */
import { defineWorkflow } from '@solidactions/sdk';
import { double } from './lib/double.js';

export default defineWorkflow({
    name: 'multi-file-echo',
    run: async (ctx) => {
        const input = ctx.input as { n?: number };
        return double(input.n ?? 0);
    },
});
