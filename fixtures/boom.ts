/**
 * Fixture workflow for the failure-path dev test.
 *
 * Throws unconditionally so invoke() returns a non-`completed` result
 * ({ status: 'failed', phase: 'run', error }). The CLI must then exit non-zero
 * rather than silently exiting 0.
 */
import { defineWorkflow } from '@solidactions/sdk';

export default defineWorkflow({
    name: 'boom',
    run: async () => {
        throw new Error('intentional failure');
    },
});
