import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AGENT_BACKENDS, AgentCliBackend } from '../core/agentCliBackends';

export function readAgentGuide(guide: boolean | AgentCliBackend | 'catalog' = false) {
    const relative = typeof guide === 'boolean' ? (guide ? 'references/install.md' : 'SKILL.md')
        : guide === 'catalog' ? 'references/providers.json'
        : AGENT_BACKENDS.includes(guide) ? `references/providers/${guide}.md` : '';
    if (!relative) throw new Error('Unknown CLI skill');
    const candidates = [path.join(__dirname, 'skills/agent-cli-verify', relative), path.resolve(__dirname, '../../skills/agent-cli-verify', relative)];
    const file = candidates.find(candidate => fs.existsSync(candidate));
    if (!file) throw new Error('CLI verification skill is missing; rebuild or update Keepwork MCP');
    return fs.readFileSync(file, 'utf8');
}
export function registerAgentGuide(server: McpServer) {
    server.registerResource('agent-cli-verify', 'keepwork://skills/agent-cli-verify/SKILL.md', {
        description: 'Discover, install and verify supported Keepwork agent CLIs on Windows/macOS.', mimeType: 'text/markdown',
    }, async uri => ({ contents: [{ uri: uri.href, text: readAgentGuide(), mimeType: 'text/markdown' }] }));
    server.registerResource('agent-cli-install', 'keepwork://skills/agent-cli-verify/references/install.md', {
        description: 'Official CLI installation recipes, discovery, login handoff and model verification.', mimeType: 'text/markdown',
    }, async uri => ({ contents: [{ uri: uri.href, text: readAgentGuide(true), mimeType: 'text/markdown' }] }));
    for (const backend of AGENT_BACKENDS) server.registerResource(`agent-cli-${backend}`, `keepwork://skills/agent-cli-verify/references/providers/${backend}.md`, {
        description: `Runtime installation reference for ${backend} on Windows/macOS.`, mimeType: 'text/markdown',
    }, async uri => ({ contents: [{ uri: uri.href, text: readAgentGuide(backend), mimeType: 'text/markdown' }] }));
    server.registerResource('agent-cli-catalog', 'keepwork://skills/agent-cli-verify/references/providers.json', {
        description: 'Reviewed provider recipes, provenance and OS verification evidence.', mimeType: 'application/json',
    }, async uri => ({ contents: [{ uri: uri.href, text: readAgentGuide('catalog'), mimeType: 'application/json' }] }));
}
