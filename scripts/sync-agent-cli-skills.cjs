const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const skillRoot = path.join(root, 'skills/agent-cli-verify');
const developmentRoot = path.join(root, '.github/skills/agent-cli-maintenance');
const catalog = require('../.github/skills/agent-cli-maintenance/config/providers.json');

function recipe(value) {
    return value.kind === 'npm' ? `运行 \`${value.command}\`。`
        : `从 \`${value.url}\` 下载临时脚本，检查当前官方内容后用 ${value.shell || 'PowerShell'} 执行。`;
}
function render(p) {
    return `# ${p.name} CLI 维护参考

后端 ID：\`${p.id}\`。官方安装来源：[${p.name}](${p.source})。
安装说明最后人工核对：${p.reviewedAt}；该日期不代表所有系统的真实运行通过。

先读现有 CLI 路径和版本，复用可用安装。用户要求安装/更新本平台时，
通过已提供的 Keepwork \`run_terminal\` 和现有确认流程操作本机；检查请求
本身不安装其他平台。没有本机工具时说明前提，不声称浏览器已经执行。

## 安装与更新

- Windows：${recipe(p.windows)}证据：${p.windows.evidence}。
- macOS：${recipe(p.macos)}证据：${p.macos.evidence}。
- 检查版本：\`${p.commands[0]} --version\`；安装后旧 GUI PATH 可能尚未刷新，
  先检查常见安装目录，不为此重复安装。
- 登录入口：\`${p.login}\`。在用户可见终端让用户完成授权，不复制凭据。
- 更新：${p.update ? `\`${p.update}\`，仍需确认当前官方方法与原有安装渠道一致。` : '沿用原安装渠道核对官方稳定版，再执行对应包管理器更新；先记录旧版本与回退方法。'}

${p.notes.map(note => '- ' + note).join('\n')}

## 维护验证

原生协议：\`${p.protocol}\`；注册的命令候选：${p.commands.map(c => '`' + c + '`').join('、')}；
原生参数：\`${p.args.join(' ') || '由 Claude stream-json adapter 构造'}\`。
定期核对官方发布说明、安装脚本和协议变化。更新安装参考与源码注册表后，
重新同步 AIChat/MCP Skill，并运行对应发现、协议和浏览器回归。

分别记录：文档核对、CLI 版本/路径、握手、原生模型/思考选项、真实工具与
两轮继续、断线重连。所有者和业务工作区必须隔离；常驻进程和能力可复用。
模型 ID/选项不能静态猜测，原生未提供的思考选项保持禁用。
未安装、未登录、未测试、超时都不能记作通过；不自动重放不确定的请求。
真实验证使用两处临时工作区，不修改用户项目。更新前后保留结果，
仅在相关验收通过后推进产品更新；不在本技能中擅自发布产品。

共享验证流程见仓库 \`skills/agent-cli-verify/SKILL.md\`。
全平台开发流程见 [维护 Skill](../../SKILL.md)。
`;
}

function installReference(p) {
    return `# ${p.name} CLI 安装参考\n\n这是产品运行时安装参考，不是独立 Skill。后端：\`${p.id}\`。\n官方来源：[${p.name}](${p.source})；核对日期：${p.reviewedAt}。\n\n先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。\n\n- Windows：${recipe(p.windows)}证据：${p.windows.evidence}。\n- macOS：${recipe(p.macos)}证据：${p.macos.evidence}。\n- 版本：\`${p.commands[0]} --version\`。\n- 登录：\`${p.login}\`，由用户完成授权，不读取或复制凭据。\n\n${p.notes.map(n => '- ' + n).join('\n')}\n\n安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。\n`;
}

function sync({ aichatDir, write = false } = {}) {
    if (!aichatDir || !fs.existsSync(path.join(aichatDir, 'AIChat.html'))) throw new Error('An existing AIChat directory is required');
    const destination = path.join(path.resolve(aichatDir), 'skills/agent-cli-setup');
    const desired = [];
    for (const p of catalog.providers) {
        desired.push([path.join(developmentRoot, `references/providers/${p.id}.md`), render(p)]);
        const relative = `references/providers/${p.id}.md`, content = installReference(p);
        desired.push([path.join(skillRoot, relative), content], [path.join(destination, relative), content]);
    }
    const manifest = fs.readFileSync(path.join(developmentRoot, 'config/providers.json'), 'utf8');
    desired.push([path.join(destination, 'providers.json'), manifest], [path.join(skillRoot, 'references/providers.json'), manifest]);
    const changed = desired.filter(([file, content]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content);
    if (write) for (const [file, content] of changed) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
    return changed.map(([file]) => file);
}
module.exports = { render, installReference, sync };
if (require.main === module) {
    const args = process.argv.slice(2), index = args.indexOf('--aichat-dir');
    try {
        const changed = sync({ aichatDir: index < 0 ? undefined : args[index + 1], write: args.includes('--write') });
        console.log(`${changed.length} skill files ${args.includes('--write') ? 'updated' : 'need synchronization'}`);
        if (changed.length && !args.includes('--write')) process.exitCode = 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
