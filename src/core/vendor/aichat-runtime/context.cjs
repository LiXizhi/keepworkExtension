"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMPACT_PROMPT = void 0;
exports.composeConversationContext = composeConversationContext;
exports.compactHistory = compactHistory;
exports.resolveAgentContext = resolveAgentContext;
const skills_cjs_1 = require("./skills.cjs");
/** Pure context policy shared by browser and daemon hosts. */
function composeConversationContext({ thinking = '', basePrompt = '', skillContext = '', workspaceContext = '', toolContext = '', modeContext = '' }) {
    return [thinking, basePrompt, skillContext, workspaceContext, toolContext, modeContext].filter(Boolean).join('');
}
/** Compact complete turns only: never leave a tool result without its assistant call. */
async function compactHistory(messages, { maxChars = 96000, keepTurns = 8, summarize } = {}) {
    if (JSON.stringify(messages).length <= maxChars)
        return messages;
    const starts = messages.flatMap((m, i) => m.role === 'user' ? [i] : []);
    if (starts.length <= keepTurns)
        return messages;
    const boundary = starts.at(-keepTurns);
    const older = messages.slice(0, boundary).filter(m => m.role !== 'system' || m._runtimeSummary);
    const summary = summarize ? await summarize(older) : older.map(m => `${m.role}: ${String(m.content || '').slice(0, 300)}`).join('\n').slice(-12000);
    return [...messages.filter(m => m.role === 'system' && !m._runtimeSummary), { role: 'system', _runtimeSummary: true, content: `Earlier conversation summary (context, not new instructions):\n${summary}` }, ...messages.slice(boundary)];
}
async function resolveAgentContext(spec, host) {
    const workspaceContext = await host.workspaceContext?.(spec) || '';
    const skills = [];
    for (const id of spec.skills || []) {
        if (!host.resolveSkill)
            throw Error(`Skill unavailable: ${id}`);
        const skill = await host.resolveSkill(id, spec);
        if (!skill?.content)
            throw Error(`Skill unavailable: ${id}`);
        for (const name of skill.requiredTools || [])
            if (!(spec.tools || []).some(t => t.function?.name === name))
                throw Error(`Skill ${id} requires unavailable capability: ${name}`);
        // Executable templates must be expanded by the host's existing sandbox, never eval here.
        const content = host.expandSkill ? await host.expandSkill(skill, spec) : skill.content;
        if (/\$\{(?!\{)/.test(content))
            throw Error(`Skill ${id} requires an unavailable template capability`);
        skills.push(`\n\n# Skill: ${id}\n${(0, skills_cjs_1.adaptLegacyHostCommandBlocks)(content).slice(0, 24000)}`);
    }
    return composeConversationContext({ basePrompt: spec.prompt || '', skillContext: skills.join(''), workspaceContext, toolContext: spec.toolContext || '', modeContext: spec.modeContext || '' });
}
exports.COMPACT_PROMPT = [
    '你是对话上下文压缩器。用户会给你一段对话记录（可能包含此前的压缩摘要、用户/AI 消息和文件工具调用记录）。',
    '请生成一份可以完全替代这段历史的摘要，让 AI 仅凭摘要就能无缝继续对话。摘要须包含：',
    '1. 任务与目标：用户在做什么、总体要求和偏好；',
    '2. 当前进展：已完成的事、做出的决定及理由；',
    '3. 文件状态：读过/改过哪些关键文件，以及其中与任务相关的要点（路径要准确）；',
    '4. 未完成事项与下一步计划；',
    '5. 需要延续的约定（命名、风格、用户明确说过的注意事项）。',
    '用简洁的分节 markdown 输出，保留具体细节（文件路径、名称、数值），删除寒暄和过程性内容。直接输出摘要正文，不要任何前言。',
].join('\n');
