import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Resource, Tool } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, ServerRuntime } from './server';
import { dashboardSkillMetadata } from './dashboardSkill';

/** Read public registration metadata only: no tool calls, resource reads or HTTP sessions. */
export async function mcpCatalog(runtime: ServerRuntime) {
    const server = createMcpServer({ ...runtime, includeSetupGuides: true });
    const client = new Client({ name: 'dashboard-catalog', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const tools: Tool[] = [];
        const resources: Resource[] = [];
        let cursor: string | undefined;
        do {
            const page = await client.listTools({ cursor });
            tools.push(...page.tools);
            cursor = page.nextCursor;
        } while (cursor);
        do {
            const page = await client.listResources({ cursor });
            resources.push(...page.resources);
            cursor = page.nextCursor;
        } while (cursor);
        const skills = resources.filter(resource => resource.uri.endsWith('/SKILL.md'));
        skills.push({ ...dashboardSkillMetadata, uri: '/dashboard/skills/keepwork-mcp-assistant/SKILL.md', mimeType: 'text/markdown' });
        return {
            tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
            skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
            references: resources.filter(resource => !resource.uri.endsWith('/SKILL.md')),
        };
    } finally {
        await client.close();
        await server.close();
    }
}
