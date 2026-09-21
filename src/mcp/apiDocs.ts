import { listParacraftActions } from '../core/paracraftClients';

interface ApiEntry {
    group: string;
    method: string;
    path: string;
    description: string;
    auth: string;
    parameters: string;
    example: string;
}

export function apiDocs(port: number, requireAuth: boolean, dingtalkAvailable: boolean) {
    const endpoints: ApiEntry[] = [];
    const base = `http://127.0.0.1:${port}`;
    const guarded = requireAuth ? 'Bearer token required' : 'Optional Bearer token; authentication currently disabled';
    const add = (group: string, method: string, route: string, description: string, parameters = 'No parameters.', samplePath = route, body?: unknown, auth = guarded) => {
        const headers: Record<string, string> = {};
        if (auth !== 'No token required') headers.Authorization = 'Bearer <PAIRING_TOKEN>';
        if (group === 'DingTalk') headers.Origin = base;
        if (group === 'MCP') {
            headers.Accept = method === 'GET' ? 'text/event-stream' : 'application/json, text/event-stream';
            if (method !== 'POST') {
                headers['Mcp-Session-Id'] = '<SESSION_ID>';
                headers['MCP-Protocol-Version'] = '2025-03-26';
            }
        }
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const options = { method, ...(Object.keys(headers).length ? { headers } : {}), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
        endpoints.push({ group, method, path: route, description, auth, parameters,
            example: `fetch(${JSON.stringify(base + samplePath)}, ${JSON.stringify(options, null, 2)})\n  .then(response => response.text())\n  .then(console.log);` });
    };
    add('Service', 'GET', '/health', 'Service identity, runtime capabilities, workspace and Web Paracraft instances.', undefined, undefined, undefined, 'No token required');
    add('Service', 'GET', '/dashboard', 'Browser dashboard HTML.', undefined, undefined, undefined, 'No token required');
    add('Service', 'GET', '/dashboard/skills/keepwork-mcp-assistant/SKILL.md', 'Bundled MCP assistant instructions for the dashboard temporary AIChat. Contains no credentials or private runtime data.', undefined, undefined, undefined, 'No token required');
    add('Service', 'GET', '/', 'Default browser dashboard HTML.', undefined, undefined, undefined, 'No token required');
    add('Admin', 'GET', '/admin/status', 'Daemon status and connected MCP sessions. Allowed Origin required when supplied.');
    add('Admin', 'GET', '/admin/dingtalk', 'Whether DingTalk is listening, plus recent received messages and reply state. Does not include pairing tokens or AIChat logins.');
    add('Admin', 'GET', '/admin/history', 'Newest-first tool-call history.', 'Query: offset (default 0), limit (default 20, max 50).', '/admin/history?offset=0&limit=20');
    add('Admin', 'GET', '/admin/api-docs', 'Structured API catalog for the current daemon.');
    add('Admin', 'POST', '/admin/stop', 'Stops the daemon and disconnects clients. Restart externally.');
    add('MCP', 'POST', '/mcp', 'Streamable HTTP JSON-RPC. Initialize first; retain Mcp-Session-Id from response headers. Use tools/list to discover live tools and their input schemas, then tools/call.', 'Headers: Accept: application/json, text/event-stream. Subsequent requests: Mcp-Session-Id and MCP-Protocol-Version. Body: JSON-RPC 2.0.', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'api-example', version: '1.0' } } });
    for (const method of ['GET', 'DELETE']) add('MCP', method, '/mcp', method === 'GET' ? 'Open the session event stream.' : 'Close an MCP session.', 'Headers: Mcp-Session-Id, MCP-Protocol-Version; GET also requires Accept: text/event-stream.');
    add('Files', 'GET', '/exists', 'Verify an absolute or home-relative directory.', 'Query: path (required).', '/exists?path=~', undefined, 'No token required');
    add('Files', 'GET', '/fs/locations', 'Common OS folders and filesystem roots.');
    add('Files', 'GET', '/fs/browse', 'Shallow folder picker listing.', 'Query: path, hidden=1, filter, offset, limit.', '/fs/browse?path=~');
    for (const [route, description, extra] of [
        ['list', 'List workspace paths.', 'max, recursive=1'], ['search', 'Search filenames.', 'q (required), max'],
        ['stat', 'Inspect file or directory metadata.', ''], ['file', 'Read raw bytes or base64 JSON.', 'links=include, base64=true'],
    ]) add('Files', 'GET', '/fs/' + route, description, 'Query: root (verified absolute directory), path (relative); ' + extra,
        '/fs/' + route + '?root=%3CROOT%3E&path=example.txt' + (route === 'search' ? '&q=example' : ''), undefined, 'No token required');
    for (const route of ['file', 'dir']) for (const method of ['PUT', 'DELETE']) add('Files', method, '/fs/' + route,
        method === 'PUT' ? 'Create/write a confined ' + route + '.' : 'Delete a confined ' + route + (route === 'dir' ? ' recursively.' : '.'),
        'Query: root (required), path (relative). PUT /fs/file body: raw UTF-8 or bytes, not JSON.', '/fs/' + route + '?root=%3CROOT%3E&path=%3CPATH%3E', undefined, 'No token required');
    for (const method of ['GET', 'POST']) add('Files', method, '/fs/reveal', 'Reveal a confined path in the OS file manager or open it with its default application.', 'Query: root, path, mode=open|dir (optional).', '/fs/reveal?root=%3CROOT%3E&path=%3CPATH%3E', undefined, 'No token required');
    add('Terminal', 'POST', '/terminal/sessions', 'Create a user-operated PTY session. Session ownership is bound to Origin.', 'JSON: cwd, cols, rows (optional).', undefined, { cols: 100, rows: 30 });
    for (const action of ['output', 'stream']) add('Terminal', 'GET', '/terminal/sessions/{id}/' + action, action === 'stream' ? 'Long-lived NDJSON output with cursor replay.' : 'Read buffered terminal output.', 'Path: id. Query: cursor (default 0). Use the same Origin as session creation.');
    for (const [action, body] of Object.entries({ commands: { command: '<COMMAND>' }, input: { data: '<INPUT>' }, resize: { cols: 100, rows: 30 }, interrupt: {} })) add('Terminal', 'POST', '/terminal/sessions/{id}/' + action, 'Terminal ' + action + '.', 'Path: id. JSON body as below. Same Origin as session creation.', undefined, body);
    add('Terminal', 'DELETE', '/terminal/sessions/{id}', 'Close the owned PTY session.', 'Path: id. Same Origin as session creation.');
    for (const method of ['GET', 'POST']) add('Calendar', method, '/calendar/reminders', method === 'GET' ? 'Inspect reminder state.' : 'Replace the reminder set; an empty events array clears it.', 'POST JSON: events [{id,title,start,remindAt,openUrl}], horizonDays.', undefined, method === 'POST' ? { events: [], horizonDays: 7 } : undefined, 'No token required');
    add('Paracraft', 'GET', '/paracraft/clients', 'List live desktop clients; excludes WASM instances.');
    add('Paracraft', 'GET', '/paracraft/{id}/timeline', 'Recent screenshots and action summaries.', 'Path: id. Query: limit (default 20).');
    for (const action of listParacraftActions()) {
        add('Paracraft', 'POST', '/paracraft/{id}/' + action, 'Dispatch engine action: ' + action + '.', 'Path: id from /paracraft/clients. JSON: engine action parameters; consult the bundled engine CLI reference. GET is also accepted with an empty payload. camera_capture uses independent eye/lookat world vectors.', undefined, {});
    }
    for (const [route, body] of Object.entries({ register: { clientId: '<CLIENT_ID>', platform: 'desktop' }, unregister: { clientId: '<CLIENT_ID>' }, '{id}/jobs/poll': { waitMs: 2000 }, '{id}/jobs/results': { results: [{ jobId: '<JOB_ID>', result: {} }] }, '{id}/jobs/{jobId}/result': { result: {} } })) add('Paracraft bridge', 'POST', '/paracraft/' + route, 'Engine registration / job transport. Intended for Paracraft clients.', 'Replace path placeholders; JSON body as below.', undefined, body, 'No token required');
    add('Web Paracraft', 'GET', '/webserver/{instance}/{path}', 'Proxy an external WASM NPL wiki request. Other HTTP methods are forwarded as well.', 'instance and root from /health.webservers; path is the wiki resource.', undefined, undefined, 'No token required');
    if (dingtalkAvailable) {
        const auth = 'Bearer token always required, plus an explicit allowed Origin (even when global auth is off)';
        add('DingTalk', 'GET', '/dingtalk/status', 'Integration configuration, listener state and reply status. Does not include AIChat tokens.', undefined, undefined, undefined, auth);
        for (const [action, body] of Object.entries({ configure: {}, enable: { mode: 'reply', consent: true }, pause: {}, test: { question: '<QUESTION>' }, send: { id: '<DRAFT_ID>', confirmation: '<USER_CONFIRMATION>' }, reconcile: { id: '<DRAFT_ID>' } })) add('DingTalk', 'POST', '/dingtalk/' + action, 'Integration action: ' + action + '. reply mode answers in visible Chrome and sends to the same chat. draft mode still requires confirmation.', 'Content-Type: application/json. Configure requires the integration configuration schema; other bodies illustrated below.', undefined, body, auth);
    }
    add('AIChat', 'POST', '/aichat/presence', 'Remember the latest AIChat page URL and login in memory. A closed session does not erase it. The response never echoes the login.', 'Header: Mcp-Session-Id of a live MCP session. JSON: url, token, optional baseURL. Explicit allowed Origin required.', undefined, { url: 'https://keepwork.com/chat', token: '<KEEPWORK_LOGIN>' }, 'Live Mcp-Session-Id and explicit allowed Origin');
    return { description: 'Runtime API catalog. Examples are JavaScript fetch calls; replace placeholders before use. Browser requests remain subject to Origin rules. Write, terminal and lifecycle operations have side effects. MCP tool schemas are available through tools/list.', endpoints };
}