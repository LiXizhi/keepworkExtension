export type AgentMode = 'craft' | 'ask' | 'plan';
export const CODEX_APPROVAL_MODES = ['default', 'on-request', 'untrusted', 'never', 'read-only'] as const;
export type CodexApprovalMode = Exclude<typeof CODEX_APPROVAL_MODES[number], 'default'>;
export function agentApprovalMode(value: unknown, backend = 'codex'): CodexApprovalMode | undefined {
    if (value === undefined) return;
    if (backend !== 'codex') throw new Error('UNSUPPORTED_FEATURE: independent approval is only available for Codex');
    if (!CODEX_APPROVAL_MODES.includes(value as any)) throw new Error('Unsupported Codex approval mode');
    return value === 'default' ? undefined : value as CodexApprovalMode;
}
export function agentMode(value: unknown = 'craft'): AgentMode {
    if (value === 'craft' || value === 'ask' || value === 'plan') return value;
    throw new Error('Unsupported agent mode');
}
export function agentAccess(mode: AgentMode, approvalMode?: CodexApprovalMode, roots: string[] = []) {
    if (approvalMode) {
        // Explicit choices never turn Ask/Plan into write-capable modes.
        if (mode !== 'craft' || approvalMode === 'read-only')
            return { sandbox: 'read-only', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } };
        if (approvalMode !== 'never') return {
            sandbox: 'workspace-write', approvalPolicy: approvalMode,
            sandboxPolicy: { type: 'workspaceWrite', writableRoots: roots, networkAccess: false },
        };
    }
    return mode === 'craft'
        ? { sandbox: 'danger-full-access', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
        : { sandbox: 'read-only', approvalPolicy: mode === 'plan' ? 'never' : 'on-request', sandboxPolicy: { type: 'readOnly' } };
}
export const PLAN_FALLBACK = '\nAIChat Plan mode: Research and propose a detailed implementation plan with validation steps. Do not implement the task, modify project files, or perform side effects. Ask clarifying questions when needed. Return the plan in your final reply and wait for the user to switch to Craft before execution.\n';
export function unsupportedModeMethod(error: any) {
    return error?.rpcRejected && (error.code === -32601 || /method not found|unknown method|unsupported method/i.test(error.message));
}
