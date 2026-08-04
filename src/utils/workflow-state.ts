export type WorkflowEffectiveState = 'retired' | 'off' | 'blocked (project off)' | 'on';

export interface WorkflowStateInput {
    enabled?: boolean;
    project_enabled?: boolean;
    retired?: boolean;
}

/**
 * Derive the operator-facing workflow gate state in admission precedence.
 *
 * The server also reports `effective_enabled`, but callers need the richer
 * reason label and older responses may omit that derived boolean.
 */
export function workflowEffectiveState(workflow: WorkflowStateInput): WorkflowEffectiveState {
    if (workflow.retired === true) return 'retired';
    if (workflow.enabled === false) return 'off';
    if (workflow.project_enabled === false) return 'blocked (project off)';
    return 'on';
}
