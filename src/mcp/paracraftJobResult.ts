// Display-only projection. The engine's job/result remains authoritative; full
// detail is fetched from the same job ID, never by executing the source again.
function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function summarizeCreationJob(body: unknown): unknown {
    if (!record(body) || body.ok === false) return body;
    const nested = record(body.result) && typeof body.result.state === 'string';
    const job = nested ? body.result as Record<string, unknown> : body;
    if (job.ok === false || typeof job.state !== 'string' || !record(job.result)) return body;
    const value = job.result;
    if (!record(value.animation) || !Array.isArray(value.animation.actors)) return body;
    const omitted: Array<{ path: string; count: number; firstSeconds?: number; lastSeconds?: number }> = [];
    const actors = value.animation.actors.map((actor: unknown, index: number) => {
        if (!record(actor) || !Array.isArray(actor.rotationKeys) || !actor.rotationKeys.length) return actor;
        const { rotationKeys, ...summary } = actor;
        const first = rotationKeys[0], last = rotationKeys.at(-1);
        omitted.push({ path: `result.animation.actors[${index}].rotationKeys`, count: rotationKeys.length,
            ...(record(first) && typeof first.time === 'number' ? { firstSeconds: first.time } : {}),
            ...(record(last) && typeof last.time === 'number' ? { lastSeconds: last.time } : {}) });
        return summary;
    });
    if (!omitted.length) return body;
    const summary = { ...job, result: { ...value, animation: { ...value.animation, actors } },
        resultDetails: { mode: 'summary', omitted, full: { action: 'code_job',
            ...(record(job.identity) ? { clientId: job.identity.clientId } : {}),
            ...(typeof job.authoringSession === 'string' ? { chatSessionId: job.authoringSession } : {}),
            params: { jobId: job.jobId, resultDetail: 'full', ...(record(job.identity) ? { expectedIdentity: job.identity } : {}) } } } };
    return nested ? { ...body, result: summary } : summary;
}
