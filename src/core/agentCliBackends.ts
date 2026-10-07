/** Provider launch contracts; browser callers cannot supply executables or flags. */
export const AGENT_BACKENDS = ['codex', 'workbuddy', 'copilot', 'claude', 'cursor', 'trae', 'qwen', 'gemini', 'kimi', 'codebuddy', 'opencode'] as const;
export type AgentCliBackend = typeof AGENT_BACKENDS[number];
export type AcpBackend = Exclude<AgentCliBackend, 'codex' | 'claude'>;
type Definition = { name: string; protocol: 'codex' | 'acp' | 'claude'; commands: string[]; args: string[]; npm?: string; login: string; installUrl: string };
export const AGENT_CLI: Record<AgentCliBackend, Definition> = {
    codex: { name: 'Codex', protocol: 'codex', commands: ['codex'], args: ['app-server', '--stdio'], npm: '@openai/codex', login: 'codex login', installUrl: 'https://developers.openai.com/codex/cli/' },
    workbuddy: { name: 'WorkBuddy', protocol: 'acp', commands: ['codebuddy', 'workbuddy', 'cbc', 'codebuddy-code'], args: ['--acp'], npm: '@tencent-ai/codebuddy-code', login: 'codebuddy /login', installUrl: 'https://www.codebuddy.cn/docs/cli/installation' },
    copilot: { name: 'Copilot', protocol: 'acp', commands: ['copilot'], args: ['--acp', '--stdio', '--no-auto-update'], npm: '@github/copilot', login: 'copilot login', installUrl: 'https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli' },
    claude: { name: 'Claude Code', protocol: 'claude', commands: ['claude'], args: [], npm: '@anthropic-ai/claude-code', login: 'claude auth login', installUrl: 'https://code.claude.com/docs/en/setup' },
    cursor: { name: 'Cursor', protocol: 'acp', commands: ['cursor-agent', 'agent'], args: ['acp'], login: 'agent login', installUrl: 'https://cursor.com/docs/cli/installation' },
    trae: { name: 'Trae', protocol: 'acp', commands: ['traecli', 'traex'], args: ['acp', 'serve'], login: 'traecli', installUrl: 'https://docs.trae.cn/cli_get-started-with-trae-code-cli-2' },
    qwen: { name: 'Qwen Code', protocol: 'acp', commands: ['qwen'], args: ['--acp'], npm: '@qwen-code/qwen-code', login: 'qwen', installUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/' },
    gemini: { name: 'Gemini CLI', protocol: 'acp', commands: ['gemini'], args: ['--experimental-acp'], npm: '@google/gemini-cli', login: 'gemini', installUrl: 'https://geminicli.com/docs/get-started/installation/' },
    kimi: { name: 'Kimi CLI', protocol: 'acp', commands: ['kimi'], args: ['acp'], npm: '@moonshot-ai/kimi-code', login: 'kimi login', installUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html' },
    codebuddy: { name: 'CodeBuddy', protocol: 'acp', commands: ['codebuddy', 'cbc', 'codebuddy-code'], args: ['--acp'], npm: '@tencent-ai/codebuddy-code', login: 'codebuddy /login', installUrl: 'https://www.codebuddy.cn/docs/cli/installation' },
    opencode: { name: 'OpenCode', protocol: 'acp', commands: ['opencode'], args: ['acp'], npm: 'opencode-ai', login: 'opencode auth login', installUrl: 'https://opencode.ai/docs/' },
};
