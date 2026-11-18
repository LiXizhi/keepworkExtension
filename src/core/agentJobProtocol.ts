/** Versioned wire contract shared by job providers and persona runners. */
export const AGENT_JOB_PROTOCOL = 'keepwork.agent-job.v1' as const;

export type AgentJobCapability = {
    id:string;
    label?:string;
    source?:'built-in'|'grant'|string;
};

export type AgentJobActionSpec = {
    requiredNodes?:string[];
    requiredOutputFields?:string[];
    defaultMaxSteps?:number;
    defaultTokenBudget?:number;
    requiresEvidence?:boolean;
};

export type AgentJobCapabilities = {
    protocol?:typeof AGENT_JOB_PROTOCOL|string;
    roles?:AgentJobCapability[];
    kinds?:Array<{kind:string;defaultRole?:string}>;
    statuses?:string[];
    actions?:string[];
    result?:{schemaVersion?:number;evidenceRequired?:boolean};
    actionSpecs?:Record<string,AgentJobActionSpec>;
    budgetEnforcement?:boolean;
};

export type AgentJobContext = {
    recentMessages?:Array<Record<string,unknown>>;
    leadScore?:Record<string,unknown>|null;
    knowledgeCandidates?:Array<Record<string,unknown>>;
    customerMemories?:Array<Record<string,unknown>>;
    budget?:{maxSteps?:number;stepsUsed?:number;tokenBudget?:number;tokensUsed?:number};
    actionSpec?:AgentJobActionSpec|null;
};

export type AgentJobRecord = {
    id:string;
    kind?:string;
    role?:string;
    status?:string;
    version?:number;
    subject_module?:string;
    subject_id?:string;
    parent_job_id?:string|null;
    cause_event?:string|null;
    payload_json?:string;
    payload?:Record<string,unknown>;
    context?:AgentJobContext;
    [key:string]:unknown;
};

export function validAgentJobRole(value:string) {
    return /^[\p{L}\p{N}_-]{1,80}$/u.test(value);
}
