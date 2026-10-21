import { AGENT_BACKENDS, AGENT_CLI, AgentCliBackend } from './agentCliBackends';
import { CliLaunch, resolveAgentCli } from './agentCliProcess';

// Reviewed native flows, matching AIChat's accountInstructions. Slash inputs
// require the native interactive CLI; they are never sent to a system shell.
const flows: Record<AgentCliBackend, { login: string[]; logout?: string[]; input?: string }> = {
    codex: { login: ['login'], logout: ['logout'] },
    claude: { login: ['auth', 'login'], logout: ['auth', 'logout'] },
    cursor: { login: ['login'], logout: ['logout'] },
    trae: { login: [], logout: ['logout'] },
    opencode: { login: ['auth', 'login'], logout: ['auth', 'logout'] },
    gemini: { login: [], logout: [], input: '/logout' },
    qwen: { login: [], input: '/auth' },
    kimi: { login: ['login'], logout: [], input: '/logout' },
    copilot: { login: ['login'], logout: [], input: '/logout' },
    workbuddy: { login: ['/login'], logout: [], input: '/logout' },
    codebuddy: { login: ['/login'], logout: [], input: '/logout' },
};
export function accountShellCommand(launch: CliLaunch, platform = process.platform) {
    const quote = (word: string) => platform === 'win32'
        ? "'" + word.replace(/'/g, "''") + "'"
        : "'" + word.replace(/'/g, "'\\''") + "'";
    return (platform === 'win32' ? '& ' : '') + [launch.executable, ...launch.args].map(quote).join(' ');
}
export function agentAccountCatalog(resolve = resolveAgentCli, platform = process.platform) {
    return Object.fromEntries(AGENT_BACKENDS.map(backend => {
        const spec = AGENT_CLI[backend], flow = flows[backend];
        try {
            const launch = resolve(backend, flow.login);
            const actions: Record<string, { label: string; command: string; input?: string }> = {
                login: { label: backend === 'qwen' ? '登录 / 更换账号' : '登录', command: accountShellCommand(launch, platform), ...(backend === 'qwen' ? { input: flow.input } : {}) },
            };
            if (flow.logout) actions.logout = { label: '登出', command: accountShellCommand(resolve(backend, flow.logout), platform), ...(flow.input ? { input: flow.input } : {}) };
            return [backend, { name: spec.name, available: true, cli: { path: launch.path, source: launch.source }, actions }];
        } catch (error) {
            return [backend, { name: spec.name, available: false, actions: {}, error: (error as Error).message }];
        }
    }));
}
