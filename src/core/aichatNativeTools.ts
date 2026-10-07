import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** One MCP identity per owned CLI conversation; native tools never route back to the web gateway. */
export class AichatNativeTools {
    private client?: Client;
    private connecting?: Promise<Client>;
    constructor(private connection: () => { url: string; token: string }) {}
    private connect() {
        return this.connecting ||= (async () => {
            const connection = this.connection();
            const client = new Client({ name: 'aichat-cli-tools', version: '1.0.0' });
            await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } } }));
            this.client = client; return client;
        })().catch(error => { this.connecting = undefined; throw error; });
    }
    async list() { return (await (await this.connect()).listTools()).tools.filter(t => !t.name.startsWith('aichat_')).map(t => ({ ...t, execution: 'mcp', online: true })); }
    async call(name: string, args: any) { return (await this.connect()).callTool({ name, arguments: args }); }
    close() { void this.client?.close().catch(() => {}); this.connecting = undefined; }
}
