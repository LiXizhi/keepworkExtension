/** Only the native Codex command approval may propose a persistent exec policy. */
export function canAutoApprove(request: any): boolean {
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(request.method)
        || request.params?.requiresUserDecision) return false;
    const options = request.params?.availableDecisions;
    return !Array.isArray(options) || options.includes('accept');
}

function prefix(decision: any): string[] | undefined {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)
        || Object.keys(decision).length !== 1) return;
    const amendment = decision.acceptWithExecpolicyAmendment;
    if (!amendment || typeof amendment !== 'object' || Array.isArray(amendment)
        || Object.keys(amendment).length !== 1) return;
    const tokens = amendment.execpolicy_amendment;
    if (!Array.isArray(tokens) || !tokens.length || tokens.length > 256
        || !tokens.every(token => typeof token === 'string' && token.length > 0
            && token.length <= 8192 && !token.includes('\0'))
        || JSON.stringify(tokens).length > 32768) return;
    return tokens;
}

export function execpolicyDecisions(backend: string, request: any): any[] {
    if (backend !== 'codex' || request.method !== 'item/commandExecution/requestApproval') return [];
    const options = request.params?.availableDecisions;
    return Array.isArray(options) ? options.filter(option => prefix(option)) : [];
}

export function approvalDecision(backend: string, request: any, decision: any): any {
    if (typeof decision === 'string') {
        if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision))
            throw Error('Invalid approval decision');
        const options = request.params?.availableDecisions;
        if (['accept', 'acceptForSession'].includes(decision) && Array.isArray(options) && !options.includes(decision))
            throw Error('Approval decision was not offered');
        return decision;
    }
    const requested = prefix(decision);
    const offered = requested && execpolicyDecisions(backend, request).find(option =>
        JSON.stringify(prefix(option)) === JSON.stringify(requested));
    if (!offered) throw Error('Persistent approval must exactly match an offered command rule');
    // Forward the server-held proposal, never a browser-supplied expansion.
    return { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...prefix(offered)!] } };
}
