export type AgentMode = 'craft' | 'ask' | 'plan';
export function agentMode(value: unknown = 'craft'): AgentMode {
    if (value === 'craft' || value === 'ask' || value === 'plan') return value;
    throw new Error('Unsupported agent mode');
}
export function agentAccess(mode: AgentMode) {
    return mode === 'craft'
        ? { sandbox: 'danger-full-access', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
        : { sandbox: 'read-only', approvalPolicy: mode === 'plan' ? 'never' : 'on-request', sandboxPolicy: { type: 'readOnly' } };
}
export const PLAN_FALLBACK = '\nAIChat Plan mode: Research and propose a detailed implementation plan with validation steps. Do not implement the task, modify project files, or perform side effects. Ask clarifying questions when needed. Return the plan in your final reply and wait for the user to switch to Craft before execution.\n';
export function unsupportedModeMethod(error: any) {
    return error?.rpcRejected && (error.code === -32601 || /method not found|unknown method|unsupported method/i.test(error.message));
}
