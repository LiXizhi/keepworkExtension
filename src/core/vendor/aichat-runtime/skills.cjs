"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adaptLegacyHostCommandBlocks = adaptLegacyHostCommandBlocks;
exports.processSkillTemplate = processSkillTemplate;
function adaptLegacyHostCommandBlocks(content) {
    return String(content || '').replace(/```aichat-host\s*\n([\s\S]*?)```/gi, (block, json) => {
        try {
            const request = JSON.parse(json);
            if (!request || Array.isArray(request) || typeof request !== 'object' || !request.command) {
                return block;
            }
            const toolArgs = JSON.stringify({
                cmd: String(request.command),
                args: request.args && typeof request.args === 'object' && !Array.isArray(request.args)
                    ? request.args
                    : {},
            });
            return `请直接调用 runWorkspaceCmd 工具，参数为 ${toolArgs}；不要把这段参数输出到回复正文。`;
        }
        catch {
            return block;
        }
    });
}
// ──────────────────── System prompt injection ────────────────────
/**
 * Leave GitHub Actions-style `${{ ... }}` literals untouched while expanding
 * AIChat `${...}` sandbox templates. Skills often embed CI YAML examples.
 */
async function processSkillTemplate(sandbox, text) {
    const slots = [];
    const masked = String(text || '').replace(/\$\{\{[\s\S]*?\}\}/g, (match) => {
        const i = slots.length;
        slots.push(match);
        return `\uE000SKILL_TMPL_${i}\uE000`;
    });
    const expanded = await sandbox.processTemplate(masked);
    return String(expanded || '').replace(/\uE000SKILL_TMPL_(\d+)\uE000/g, (_, n) => slots[Number(n)] ?? '');
}
