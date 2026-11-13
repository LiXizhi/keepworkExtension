/** Versioned wire contract shared by job providers and persona runners. */
export const AGENT_JOB_PROTOCOL = 'keepwork.agent-job.v1' as const;

export type AgentJobCapability = {
    id:string;
    label?:string;
    source?:'built-in'|'grant'|string;
};

export type AgentJobCapabilities = {
    protocol?:typeof AGENT_JOB_PROTOCOL|string;
    roles?:AgentJobCapability[];
    kinds?:Array<{kind:string;defaultRole?:string}>;
    statuses?:string[];
    actions?:string[];
    result?:{schemaVersion?:number;evidenceRequired?:boolean};
};

export type AgentJobRecord = {
    id:string;
    kind?:string;
    role?:string;
    status?:string;
    version?:number;
    subject_module?:string;
    subject_id?:string;
    payload_json?:string;
    payload?:Record<string,unknown>;
    [key:string]:unknown;
};

export function validAgentJobRole(value:string) {
    return /^[\p{L}\p{N}_-]{1,80}$/u.test(value);
}
