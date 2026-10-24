"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEAM_TOOLS = exports.AGENT_RUNTIME_VERSION = exports.MAX_AGENT_DEPTH = void 0;
exports.createAgentRuntime = createAgentRuntime;
const history_cjs_1 = require("./history.cjs");
const completion_cjs_1 = require("./completion.cjs");
const context_cjs_1 = require("./context.cjs");
exports.MAX_AGENT_DEPTH = 3;
exports.AGENT_RUNTIME_VERSION = 1;
const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
exports.TEAM_TOOLS = [
    tool('runSubAgent', 'Delegate to a configured team member; wait for its answer.', { member: { type: 'string' }, uniqueName: { type: 'string' }, skill: { type: 'string' }, prompt: { type: 'string' } }, ['prompt']),
    tool('sendAgentMessage', 'Send a follow-up task to a configured team member; wait for its answer.', { member: { type: 'string' }, agentName: { type: 'string' }, text: { type: 'string' }, message: { type: 'string' } }, []),
];
/** A host owns one runtime per security owner. Only data snapshots cross this boundary. */
function createAgentRuntime(host) {
    const runs = new Map(), approvals = new Map(), conversations = new Map(), dynamicMembers = new Map();
    let sequence = 0, closed = false;
    const snapshot = id => { const run = runs.get(id); return run ? structuredClone(run.view) : null; };
    const publish = async (run, event) => {
        await host.persist?.(snapshot(run.view.id));
        host.emit?.({ ...event, runId: run.view.id, parentId: run.view.parentId });
    };
    const cancel = id => {
        const run = runs.get(id);
        if (!run)
            return false;
        run.controller.abort();
        for (const child of run.view.children)
            cancel(child);
        return true;
    };
    const respond = (id, decision) => {
        const pending = approvals.get(id);
        if (!pending)
            throw Error('Approval expired');
        if (!['accept', 'decline', 'cancel'].includes(decision))
            throw Error('Unsupported approval decision');
        pending(decision === 'accept');
    };
    async function requestApproval(run, request) {
        const id = `${run.view.id}:approval:${++sequence}`;
        let settle;
        const answer = new Promise(resolve => { settle = resolve; });
        approvals.set(id, settle);
        run.view.pending = [{ id, ...request }];
        run.view.state = 'waiting';
        try {
            await publish(run, { type: 'approval', request: run.view.pending[0] });
            if (!await (0, completion_cjs_1.abortable)(answer, run.controller.signal))
                throw Error('Owner declined tool execution');
        }
        finally {
            approvals.delete(id);
            run.view.pending = [];
            if (!run.controller.signal.aborted)
                run.view.state = 'running';
            await publish(run, { type: 'approval-resolved', id });
        }
    }
    async function turn(spec, parent = null) {
        if (closed)
            throw Error('Runtime closed');
        const id = spec.id || `run-${++sequence}`;
        if (runs.has(id))
            throw Error('Run ID already exists; inspect its snapshot instead of replaying');
        const depth = parent ? parent.view.depth + 1 : 1;
        if (depth > exports.MAX_AGENT_DEPTH)
            throw Error('Maximum agent nesting depth reached');
        const controller = new AbortController();
        const run = { controller, view: { id, parentId: parent?.view.id || null, member: spec.member || '', depth, children: [], pending: [], state: 'running', answer: '' } };
        runs.set(id, run);
        if (parent)
            parent.view.children.push(id);
        const signal = spec.signal || parent?.controller.signal;
        const abort = () => cancel(id);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted)
            abort();
        const timer = setTimeout(abort, Math.max(1, Math.min(30 * 60 * 1000, spec.timeoutMs || 30 * 60 * 1000)));
        timer?.unref?.();
        try {
            (0, completion_cjs_1.throwIfAborted)(controller.signal);
            await publish(run, { type: parent ? 'child-agent' : 'started' });
            const members = spec.members || {};
            const baseTools = spec.tools || [];
            const skillTools = host.resolveSkill ? [tool('load_skill', 'Load a workspace skill by identifier.', { id: { type: 'string' } }, ['id'])] : [];
            const tools = [...baseTools, ...skillTools, ...(depth < exports.MAX_AGENT_DEPTH ? exports.TEAM_TOOLS : [])];
            const prompt = await (0, completion_cjs_1.abortable)((0, context_cjs_1.resolveAgentContext)({ ...spec, signal: controller.signal, tools }, host), controller.signal);
            const prior = spec.history || conversations.get(spec.conversationId) || [];
            const normalized = [{ role: 'system', content: prompt }];
            for (const message of [...prior, { role: 'user', content: spec.text }])
                (0, history_cjs_1.appendMergedModelMessage)(normalized, structuredClone(message));
            const messages = await (0, completion_cjs_1.abortable)((0, context_cjs_1.compactHistory)(normalized, { ...spec.compaction, summarize: host.summarize ? older => host.summarize(older, { ...spec, signal: controller.signal }) : undefined }), controller.signal);
            const execute = async (call, args) => {
                const name = call.function.name;
                if (name === 'load_skill')
                    return (0, context_cjs_1.resolveAgentContext)({ ...spec, signal: controller.signal, tools, prompt: '', skills: [args.id] }, { resolveSkill: host.resolveSkill, expandSkill: host.expandSkill });
                if (exports.TEAM_TOOLS.some(t => t.function.name === name)) {
                    if (args.needUserControl || args.parallel)
                        throw Error('Independent browser/user-controlled sessions are unavailable in this runtime');
                    const memberName = args.member || args.uniqueName || args.agentName || `Agent-${++sequence}`;
                    const memberKey = `${spec.conversationId || id}:${memberName}`;
                    let member = Object.hasOwn(members, memberName) ? members[memberName] : dynamicMembers.get(memberKey);
                    if (!member && name === 'runSubAgent' && !Object.keys(members).length) {
                        member = { skills: args.skill ? [args.skill] : [] };
                        dynamicMembers.set(memberKey, member);
                    }
                    if (!member || typeof (args.prompt ?? args.message ?? args.text) !== 'string')
                        throw Error('Unknown team member or missing task');
                    const allowed = new Set(baseTools.map(t => t.function.name));
                    const selected = (member.tools || baseTools).filter(t => allowed.has(t.function.name));
                    // A member can narrow capabilities, never replace the host's workspace grant.
                    if (member.workspace && member.workspace !== spec.workspace)
                        throw Error('Team member workspace is not authorized by its parent');
                    const child = await turn({ ...spec, ...member, id: `${id}:child:${++sequence}`, member: memberName,
                        workspace: spec.workspace, owner: spec.owner, workspaceId: spec.workspaceId, tools: selected, members, signal: controller.signal,
                        history: undefined, conversationId: memberKey,
                        text: args.prompt ?? args.message ?? args.text }, run);
                    return child.answer;
                }
                if (host.needsApproval?.(name, args, spec))
                    await requestApproval(run, { tool: name, arguments: args });
                return host.execute(name, args, { ...spec, signal: controller.signal, runId: id });
            };
            const response = await (0, completion_cjs_1.runCompletion)({ model: spec.model || 'keepwork-pro', messages, tools, maxIterations: spec.maxIterations || 48,
                reasoning: false, stream: spec.stream ?? false, maxTokens: spec.maxTokens || 6000, abortController: controller }, {
                request: options => host.request(options, spec), execute,
                emit: event => host.emit?.({ ...event, runId: id, parentId: run.view.parentId }),
            });
            (0, completion_cjs_1.throwIfAborted)(controller.signal);
            run.view.answer = String((0, completion_cjs_1.responseText)(response));
            if (!run.view.answer.trim())
                throw Error('Executor returned no answer');
            run.view.state = 'done';
            if (spec.conversationId)
                conversations.set(spec.conversationId, [...messages.slice(1), { role: 'assistant', content: run.view.answer }]);
            await publish(run, { type: 'completed' });
            return snapshot(id);
        }
        catch (error) {
            run.view.state = controller.signal.aborted ? 'cancelled' : 'error';
            run.view.error = error.message;
            await publish(run, { type: 'completed' });
            throw error;
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            for (const child of run.view.children)
                cancel(child);
        }
    }
    return { turn, respond, cancel, snapshot, close() { closed = true; for (const id of runs.keys())
            cancel(id); conversations.clear(); dynamicMembers.clear(); } };
}
