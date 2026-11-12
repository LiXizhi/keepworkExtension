//! Keepwork local MCP Dashboard HTML, Assistant Skill, and Admin catalog routes.

use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

use crate::http::{json_response, AppState};
use crate::tools;
use crate::{SERVER_NAME, SERVER_VERSION};

const DASHBOARD_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' https://cdn.keepwork.com/keepwork/cdn/aichat/vendor/xterm/xterm-6.0.0.js https://cdn.keepwork.com/keepwork/cdn/aichat/vendor/xterm/addon-fit-0.11.0.js; style-src 'unsafe-inline' https://cdn.keepwork.com/keepwork/cdn/aichat/vendor/xterm/xterm-6.0.0.css; connect-src 'self'; frame-src https://keepwork.com http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

pub fn serve_dashboard() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_SECURITY_POLICY, DASHBOARD_CSP)
        .header("x-content-type-options", "nosniff")
        .body(Body::from(DASHBOARD_HTML))
        .expect("valid dashboard response")
}

pub fn serve_skill(port: u16, channel: &str) -> Response {
    let base = format!("http://127.0.0.1:{port}");
    let ch = if matches!(channel, "dingtalk" | "feishu") {
        format!("\nFocus channel: `{channel}`.\n")
    } else {
        String::new()
    };
    let text = format!(
        "---\nname: keepwork-mcp-assistant\ndescription: Inspect and troubleshoot the local Keepwork MCP daemon ({base}).\n---\n\n# Keepwork MCP Assistant\n\nLocal MCP endpoint: `{base}/mcp`\nDashboard: `{base}/dashboard`\n{ch}\nUse `mcp_status`, `run_terminal`, `grep_files`, `web_search`, and `fetch_url` to inspect or operate the local workspace.\n"
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/markdown; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(text))
        .expect("valid skill response")
}

pub fn api_docs(state: &AppState) -> Response {
    let base = format!("http://127.0.0.1:{}", state.port);
    let guarded = if state.require_auth {
        "Bearer token required"
    } else {
        "Optional Bearer token; authentication currently disabled"
    };
    let mut endpoints = json!([
        {
            "group": "Service",
            "method": "GET",
            "path": "/health",
            "description": "Service identity, runtime capabilities, and workspace root.",
            "auth": "No token required",
            "parameters": "No parameters.",
            "example": format!("fetch(\"{base}/health\").then(r => r.json()).then(console.log);")
        },
        {
            "group": "Service",
            "method": "GET",
            "path": "/dashboard",
            "description": "Browser dashboard HTML.",
            "auth": "No token required",
            "parameters": "No parameters.",
            "example": format!("fetch(\"{base}/dashboard\").then(r => r.text()).then(console.log);")
        },
        {
            "group": "Admin",
            "method": "GET",
            "path": "/admin/status",
            "description": "Daemon status, build identity, platform/architecture, executable path, start time and connected MCP sessions.",
            "auth": guarded,
            "parameters": "No parameters.",
            "example": format!("fetch(\"{base}/admin/status\").then(r => r.json()).then(console.log);")
        },
        {
            "group": "Admin",
            "method": "GET",
            "path": "/admin/history",
            "description": "Newest-first tool-call history.",
            "auth": guarded,
            "parameters": "Query: offset (default 0), limit (default 25, max 200).",
            "example": format!("fetch(\"{base}/admin/history?offset=0&limit=20\").then(r => r.json()).then(console.log);")
        },
        {
            "group": "Admin",
            "method": "POST",
            "path": "/admin/stop",
            "description": "Stops the daemon and disconnects clients.",
            "auth": guarded,
            "parameters": "No parameters.",
            "example": format!("fetch(\"{base}/admin/stop\", {{ method: \"POST\" }}).then(r => r.json()).then(console.log);")
        },
        {
            "group": "MCP",
            "method": "POST",
            "path": "/mcp",
            "description": "Streamable HTTP JSON-RPC. Initialize first; retain Mcp-Session-Id from response headers.",
            "auth": guarded,
            "parameters": "Headers: Accept: application/json, text/event-stream. Subsequent requests: Mcp-Session-Id.",
            "example": format!("fetch(\"{base}/mcp\", {{ method: \"POST\", headers: {{ \"Content-Type\": \"application/json\" }}, body: JSON.stringify({{ jsonrpc: \"2.0\", id: 1, method: \"initialize\", params: {{ protocolVersion: \"2025-03-26\", capabilities: {{}}, clientInfo: {{ name: \"api-example\", version: \"1.0\" }} }} }}) }}).then(r => r.json()).then(console.log);")
        },
        {
            "group": "Files",
            "method": "GET",
            "path": "/exists",
            "description": "Verify an absolute or home-relative directory.",
            "auth": "No token required",
            "parameters": "Query: path (required).",
            "example": format!("fetch(\"{base}/exists?path=~\").then(r => r.json()).then(console.log);")
        }
    ]);
    let agent_auth = format!("Explicit allowed Origin and the same private X-Agent-Owner capability (32–128 ASCII letters/digits/hyphens); {guarded}. Browser owner capabilities and bearer tokens must not be exported or logged.");
    for (method, path, description, parameters) in [
        ("POST", "/agents/personas/circles", "Owner-driven circle design and DingTalk/Feishu group operations. Shares the Node runtime's brain files and preview/receipt contracts; no autonomous multi-agent group routing.", "JSON action (default read): read, createOrganization, preview, apply, search, membersPreview, refresh, deployPreview, deploy, pullPreview, publishPreview, publish, verifyReceipt, resolve, unbind, history, send. Reuse read scope as expectedScope and organizationId (default default). Edits require expectedRevision and a single-use preview ticket; publish/send require requestId. Group writes verify the platform owner/admin; uncertain writes are inspected, never replayed. Unbind requires confirm:true and retains the external group."),
        ("GET", "/agents/backends", "Native CLI inventory or targeted protocol/account/model discovery. Installation and ACP initialization do not verify an account.", "Query: probe=executable (read-only; no child processes), backend, cwd, conversationId or owned sessionId, model, refresh=1. Missing optional capability is unknown; unsupported provider semantics return a bounded error."),
        ("GET", "/agents/accounts", "Read-only native account login/logout command catalog. Commands are displayed for user-operated terminals; this request does not execute them.", "No parameters. Reuse the original owner for later requests."),
        ("POST", "/agents/login", "Start native Codex browser login, or return another provider's reviewed terminal login command.", "JSON: {backend?}. Non-Codex terminal commands are not executed by this endpoint."),
        ("GET", "/agents/native-codex", "List native Codex CLI/editor/exec/app-server threads across providers without resuming them. Excludes threads managed by another owner.", "Query: cursor (opaque string from nextCursor). Returns sessions with threadId, title, workspace, updatedAt in milliseconds, busy; and nextCursor."),
        ("GET", "/agents/native-codex/:threadId", "Read native Codex history and attach it to one owned wrapper. Existing turn endpoints continue the original thread only after explicit submission.", "Path: native thread id. Read-only thread/read; default mode Ask. External active tasks remain read-only. Missing or invalid history never creates an empty replacement."),
        ("GET", "/agents/native-sessions/:backend", "Alias for native Codex listing when backend=codex. Other providers' history import remains explicitly unsupported.", "Query: cursor (opaque string). Same owner, Origin and optional bearer checks as native-codex."),
        ("GET", "/agents/native-sessions/:backend/:threadId", "Alias for native Codex history attachment when backend=codex.", "Path: backend=codex and native thread id. Does not resume or start execution."),
        ("GET", "/agents/sessions", "List up to 100 owned session summaries and a nextCursor.", "Query: cursor (nonnegative integer, default 0)."),
        ("POST", "/agents/sessions", "Create an idempotent owner/backend/conversation native text session. Unsupported context, model or workspace semantics are rejected before a prompt.", "JSON: {backend?,conversationId,roots,rootNames?,model?,mode?,contextVersion?,cloudPrimary?}. roots are existing absolute local directories; mode=craft|ask|plan. contextVersion=1 requires a registered AIChat page. Copilot context sessions remain unsupported."),
        ("GET", "/agents/sessions/:id", "Read the owned normalized snapshot, history, pending requests and last submission receipt. Native Codex imports refresh inactive history/busy status with thread/read; legacy Node Codex records without items recover once.", "Path: owned session id. Ordinary persisted Rust history stays local; retrieval failures are explicit. Reading never starts/resumes a thread or replays a prompt or uncertain mutation."),
        ("PATCH", "/agents/sessions/:id", "Rename, archive or remove an owned inactive session. Removal preserves native history.", "JSON: {title?,archived?,remove?}. Removal archives; this API has no DELETE route."),
        ("POST", "/agents/sessions/:id/turns", "Submit one native text turn exactly once per requestId. Empty model/effort selections retain legacy defaults; unsupported explicit semantics do not dispatch.", "JSON: {requestId,text,model?,effort?,mode?,contextVersion?}. Reconcile the original receipt after an unknown outcome; never auto-resubmit under a new id."),
        ("POST", "/agents/sessions/:id/interrupt", "Interrupt the current owned native turn and cancel bound webpage calls. Starting turns may require retrying Stop after configuration finishes.", "JSON: {}. Dispatched tool results may remain unknown; cancellation never replays them."),
        ("POST", "/agents/sessions/:id/respond", "Answer one current native approval or user question. Decisions cannot silently widen the permission scope offered by the CLI.", "JSON: {id,decision:accept|acceptForSession|decline|cancel} or {id,answers:{questionId:text}}. Persistent permission grants are accepted only when explicitly offered."),
        ("GET", "/agents/sessions/:id/events", "Bounded NDJSON full snapshots with initial reconciliation and heartbeat lines. Disconnecting a viewer does not stop execution.", "Query: cursor optional; each frame is {cursor,session}. Reconcile using session GET after EOF or failure."),
        ("POST", "/agents/contexts/:conversationId", "Register the original AIChat page's bounded instructions and tool definitions. A live page binding cannot be silently replaced.", "JSON: {pageId,generation,instructions,revision,tools:[{name,description,inputSchema}]}. Bindings are owner/conversation/page/generation scoped."),
        ("POST", "/agents/contexts/:conversationId/credentials", "Validate explicit workspace grants. Background file operations support local spaces; cloud/Git credentials are not retained or exposed to a CLI.", "JSON: {username,token?,baseURL?,git?,primaryId,spaces}. Response reports backendWorkspaceTypes:[local]; remote/cloud/Git operations require the original page online."),
        ("GET", "/agents/contexts/:conversationId/events", "SSE ready/tool/cancel events for the exact registered page and generation.", "Query: pageId and generation. Results and dispatch identity never migrate to another live page."),
        ("POST", "/agents/contexts/:conversationId/result", "Complete one outstanding webpage tool call. Wrong owner, stale page/generation and duplicate/expired call IDs are rejected.", "JSON: {pageId,generation,callId,result:{content,isError?}}. Results are bounded MCP text/image content."),
        ("POST", "/agents/contexts/:conversationId/file", "Operate only on explicitly granted local workspace files; remote/cloud/Git background execution returns unsupported-feature errors.", "JSON: {operation,path,...}. Operations: list/search/read/write/replace/delete/rename. Mutations require Craft, confined paths, and read-before-edit or expectedContent checks."),
        ("POST", "/agents/contexts/:conversationId/overlay", "Preserve Git drafts through import/get/drop/ack. Remote conflict verification, background edits and protected-deck staging remain unsupported.", "JSON: {operation,spaceId,files?,revision?,path?}. Failed imports preserve conflicting originals; unknown remote bases are never reported verified."),
        ("POST", "/agents/contexts/revoke", "Revoke this owner's page bindings, local workspace grants and private proxy capabilities.", "JSON: {}. Already dispatched mutations remain unknown and are not replayed."),
    ] {
        endpoints.as_array_mut().unwrap().push(json!({
            "group":"Native agent sessions", "method":method, "path":path,
            "description":description, "auth":agent_auth, "parameters":parameters,
            "example":format!("// owner is the same private browser capability used to create this session.\nfetch('{base}{path}', {{method:'{method}',headers:{{'X-Agent-Owner':owner{}}}{}}}).then(r=>r.json());",if method=="GET"{""}else{",'Content-Type':'application/json'"},if method=="GET"{""}else{",body:JSON.stringify(/* request documented above */ {})"})
        }));
    }
    endpoints.as_array_mut().unwrap().push(json!({
        "group":"Internal native tool bridge", "method":"POST", "path":"/agents/tool-proxy",
        "description":"Private bridge used only by this Rust binary's --agent-tool-proxy stdio mode. Supports bound tools/list, tools/call and cancellation; it is not a browser RPC tunnel.",
        "auth":"Revocable per-conversation bearer capability; rejects every Origin header. Public daemon tokens and X-Agent-Owner cannot authorize this route.",
        "parameters":"Daemon-created descriptor only. Browser callers cannot choose executables, flags, endpoint or credentials. A stale capability cannot dispatch to a replacement page.",
        "example":"Internal transport only; use the daemon-provided native MCP descriptor. Never copy its capability into browser code or logs."
    }));
    let payload: Value = json!({
        "name": SERVER_NAME,
        "version": SERVER_VERSION,
        "port": state.port,
        "requireAuth": state.require_auth,
        "endpoints": endpoints,
        "tools": tools::list(),
        "skills": [],
        "references": [],
    });
    json_response(StatusCode::OK, &payload)
}

const DASHBOARD_HTML: &str = r###"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Keepwork local MCP</title>
<style>
:root{color-scheme:light dark;font-family:"Segoe UI",sans-serif;color:light-dark(#242424,#ccc);background:light-dark(#fafafa,#1f1f1f)}
*{box-sizing:border-box}body{margin:0;padding:0;display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh;font-size:13px;line-height:1.6;background:light-dark(#fafafa,#1f1f1f)}
aside{padding:24px 16px;border-right:1px solid #7774;background:light-dark(#f0f2f3,#252526)}.brand{font-size:16px;font-weight:650;margin-bottom:24px}
.tree{display:grid;gap:4px}.tree a{display:block;border:0;padding:8px 12px;text-decoration:none;color:inherit;border-radius:3px}
.tree a[aria-current="page"]{background:light-dark(#dcecf1,#124353);color:light-dark(#164d60,#bce8f4)}
.tree details{margin-top:12px}.tree summary{padding:8px 12px;cursor:pointer}.tree details a{margin-left:14px;border-left:1px solid #7775;border-radius:0}
main{padding:28px;min-width:0;max-width:1400px;width:100%}h1{font-size:20px;margin:0 0 16px}h2{font-size:14px;margin:24px 0 8px}
.toolbar,form,.pager{display:flex;gap:10px;align-items:center;flex-wrap:wrap}button,a.btn,input{font:inherit}
button,a.btn{padding:6px 12px;border:1px solid #777;border-radius:3px;background:transparent;color:inherit;cursor:pointer;text-decoration:none}
button:disabled{opacity:.45;cursor:default}input{padding:7px;max-width:100%;background:transparent;color:inherit;border:1px solid #777;border-radius:3px}
form{margin-top:16px}form[hidden],.view[hidden]{display:none}
dl{display:grid;grid-template-columns:180px minmax(0,1fr);gap:4px 12px}dt{opacity:.7}dd{margin:0;overflow-wrap:anywhere}
#notice{color:light-dark(#a32918,#ffb09f);min-height:1.6em}.scroll{overflow:auto}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:8px;border-bottom:1px solid #7775;vertical-align:top;overflow-wrap:anywhere;max-width:340px}
th{white-space:nowrap}.empty{opacity:.65}.pager{margin-top:12px}
.api-item{border-top:1px solid #7774;padding:16px 0}.api-item summary{cursor:pointer;overflow-wrap:anywhere}.api-item pre{white-space:pre-wrap;overflow-wrap:anywhere;background:light-dark(#edf1f2,#292d2e);padding:12px}
#api-filter,#catalog-filter{width:100%;margin:12px 0}
body.chat-view main{padding:0;max-width:none;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
body.chat-view #view-title,body.chat-view #notice:empty{display:none}body.chat-view #view-chat{flex:1;min-height:0}
#chat-frame{display:block;width:100%;height:100%;border:0;background:white}
</style></head><body>
<aside><div class="brand">Keepwork<br>local MCP (Rust)</div><nav class="tree" aria-label="Dashboard navigation">
<a href="#overview">Overview / 概览</a><a href="#history">History</a><a href="#clients">Clients</a><a href="#personas">Personas / 分身</a><a href="#chat">AI 对话</a>
<details open><summary>Developer</summary><a href="#api-docs">API docs</a><a href="#tools-skills">Tools &amp; skills</a></details>
</nav></aside><main>
<h1 id="view-title">Overview / 概览</h1>
<form id="auth" hidden><label for="token">Pairing token</label><input id="token" type="password" autocomplete="off" required><button>Connect</button></form>
<p id="notice" role="status" aria-live="polite"></p>
<section class="view" id="view-overview">
<nav class="toolbar" aria-label="Service controls"><button id="refresh">Refresh</button><button id="copy">Copy MCP URL</button><a class="btn" href="https://keepwork.com/chat" target="_blank" rel="noopener noreferrer">Open AIChat</a><button id="stop" disabled>Stop service</button></nav>
<h2>服务信息</h2><dl id="meta"><dt>Status</dt><dd>Connecting...</dd></dl>
<h2>Clients</h2><div id="overview-clients" class="scroll"></div></section>
<section class="view" id="view-clients" hidden><div id="clients" class="scroll"></div></section>
<section class="view" id="view-personas" hidden><p id="persona-summary" role="status"></p><p>这里列出本机保存的全部身份记录，包含历史身份；空闲（idle）表示当前没有任务。网页来源地址或浏览器存储变化后，同一分身配置可能保留多份记录。</p><div id="personas" class="scroll"></div></section>
<section class="view" id="view-history" hidden><div id="history" class="scroll"></div>
<div class="pager"><button id="prev" disabled>Newer</button><span id="range">0 of 0</span><button id="next" disabled>Older</button></div></section>
<section class="view" id="view-api-docs" hidden><p>HTTP APIs, authentication, parameters and JavaScript fetch examples.</p><label for="api-filter">Filter APIs</label><input id="api-filter" type="search" placeholder="Method, path, or description"><div id="api-docs"></div></section>
<section class="view" id="view-tools-skills" hidden><p>Built-in MCP tool calls and input schemas.</p><label for="catalog-filter">Filter tools</label><input id="catalog-filter" type="search" placeholder="Name or description"><div id="tools-skills"></div></section>
<section class="view" id="view-chat" hidden><iframe id="chat-frame" title="Keepwork MCP AI 对话" referrerpolicy="no-referrer" allow="clipboard-write"></iframe></section>
</main>
<script>
const byId = id => document.getElementById(id);
let token = '', offset = 0, busy = false, stopped = false, view = 'overview', apiCatalog = null;
const limit = 20;
const viewNames = { overview: 'Overview / 概览', history: 'History', clients: 'Clients', personas: 'Personas / 分身', 'api-docs': 'API docs', 'tools-skills': 'Tools & skills', chat: 'AI 对话' };
async function request(path, method = 'GET', body) {
  const response = await fetch(path, { method, cache: 'no-store', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 401) { byId('auth').hidden = false; throw new Error('Pairing token required. Use the token from ~/.keepwork-mcp/token.'); }
  if (!response.ok) { const detail = await response.json().catch(() => ({})); throw new Error(detail.error || ('Request failed (' + response.status + ')')); }
  return response.json();
}
function table(target, headings, rows, empty) {
  const container = byId(target); container.replaceChildren();
  if (!rows.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = empty; container.append(p); return; }
  const el = document.createElement('table'), head = el.createTHead().insertRow();
  headings.forEach(l => { const th = document.createElement('th'); th.textContent = l; head.append(th); });
  const body = el.createTBody();
  rows.forEach(vals => { const r = body.insertRow(); vals.forEach(v => { const td = r.insertCell(); td.textContent = String(v ?? ''); }); });
  container.append(el);
}
function metadata(values) {
  byId('meta').replaceChildren();
  Object.entries(values).forEach(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = String(v); byId('meta').append(dt, dd); });
}
function displayDate(v) { const d = v ? new Date(v) : null; return d && Number.isFinite(d.getTime()) ? d.toLocaleString() : 'Unknown / 未提供'; }
function renderPersonas(data) {
  const personas = data.personas || [];
  const groups = new Set(personas.map(p => p.ownerGroup).filter(Boolean));
  const allGroupsKnown = personas.every(p => p.ownerGroup);
  const groupCount = Number.isInteger(data.stats?.ownerGroups) ? data.stats.ownerGroups : allGroupsKnown ? groups.size : null;
  byId('persona-summary').textContent = '本机保存 ' + personas.length + ' 条分身记录' + (groupCount === null ? '；身份组数未提供' : '，属于 ' + groupCount + ' 组浏览器身份') + '。这些记录不代表在线分身数量。';
  const rows = [...personas].sort((a, b) => String(a.ownerGroup || '').localeCompare(String(b.ownerGroup || '')) || String(a.id || '').localeCompare(String(b.id || ''))).map(p => [p.name, p.ownerGroup ? p.ownerGroup.slice(0, 12) : '未提供', p.id, p.root === undefined ? '未提供' : p.root || '未绑定', p.state, p.executor, p.messages, p.unread, (p.enabledSchedules || 0) + '/' + (p.schedules || 0)]);
  table('personas', ['Name', '身份组', '分身 ID', '第二大脑', 'State', 'Executor', 'Messages', 'Unread', 'Schedules'], rows, 'No personas. / 还没有分身');
}
function serverMetadata(status) {
  const unknown = 'Unknown / 未提供';
  return {
    Status: 'Running',
    'Engine / 引擎': status.runtimeEngine || 'rust',
    'MCP version / 版本': status.runtimeVersion || status.version || unknown,
    'Source / 服务来源': status.hostKind || unknown,
    'Host version / 宿主版本': status.hostVersion || 'Not reported / 未提供',
    'Git commit / 提交': status.runtimeCommit || unknown,
    'Service API version': status.version || unknown,
    URL: location.origin + '/mcp',
    'Executable / 执行程序': status.execPath || unknown,
    Platform: [status.platform, status.arch].filter(Boolean).join(' / ') || unknown,
    PID: status.pid, Port: status.port, Root: status.workspaceRoot,
    'Started at / 启动时间': displayDate(status.startedAt),
    Uptime: Math.round((status.uptimeMs || 0) / 1000) + 's',
    Auth: status.requireAuth ? 'Token required' : 'Open (loopback only)',
  };
}
function startChat() {
  const url = new URL('https://keepwork.com/chat');
  const params = { layout: 'thin', chat: 'new', persist: '0', frontpage: 'hide', disable_automation: '1', hide: 'sidebar,pet,share,history,search', skill: 'keepwork-mcp-assistant', skillUrl: location.origin + '/dashboard/skills/keepwork-mcp-assistant/SKILL.md', skillName: 'Keepwork MCP Assistant' };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  byId('chat-frame').src = url.href;
}
function renderCatalog() {
  if (!apiCatalog) return;
  const query = byId('catalog-filter').value.toLowerCase();
  byId('tools-skills').replaceChildren();
  const rows = (apiCatalog.tools || []).filter(e => JSON.stringify(e).toLowerCase().includes(query));
  if (!rows.length) { byId('tools-skills').textContent = 'No matching tools.'; return; }
  for (const entry of rows) {
    const article = document.createElement('article'); article.className = 'api-item';
    const name = document.createElement('strong'); name.textContent = entry.name;
    const desc = document.createElement('p'); desc.textContent = entry.description || '';
    const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
    summary.textContent = 'Input schema'; pre.textContent = JSON.stringify(entry.inputSchema, null, 2);
    details.append(summary, pre); article.append(name, desc, details); byId('tools-skills').append(article);
  }
}
function renderApis() {
  if (!apiCatalog) return;
  const query = byId('api-filter').value.toLowerCase();
  byId('api-docs').replaceChildren();
  const entries = (apiCatalog.endpoints || []).filter(e => JSON.stringify(e).toLowerCase().includes(query));
  if (!entries.length) { byId('api-docs').textContent = 'No matching APIs.'; return; }
  for (const entry of entries) {
    const details = document.createElement('details'); details.className = 'api-item';
    const summary = document.createElement('summary'); summary.textContent = entry.method + ' ' + entry.path + '  |  ' + entry.group;
    const desc = document.createElement('p'); desc.textContent = entry.description;
    const auth = document.createElement('p'); auth.textContent = 'Auth: ' + entry.auth;
    const params = document.createElement('pre'); params.textContent = entry.parameters;
    const ex = document.createElement('pre'); ex.textContent = entry.example;
    details.append(summary, desc, auth, params, ex); byId('api-docs').append(details);
  }
}
async function refresh() {
  if (busy || stopped) return;
  busy = true; byId('refresh').disabled = true;
  const requestedView = view;
  try {
    const status = await request('/admin/status');
    metadata(serverMetadata(status));
    const clientRows = (status.clients || []).map(c => [c.sessionId.slice(0, 8), c.origin, c.connectedAt, c.lastSeenAt, c.callCount]);
    for (const t of ['clients', 'overview-clients']) table(t, ['Session', 'Origin', 'Connected', 'Last seen', 'Calls'], clientRows, 'No connected AIChat sessions.');
    if (requestedView === 'personas') {
      const data = await request('/admin/personas');
      renderPersonas(data);
    }
    if (requestedView === 'history') {
      let page = await request('/admin/history?offset=' + offset + '&limit=' + limit);
      table('history', ['Time', 'Client', 'Tool', 'Summary', 'Result', 'ms'], (page.history || []).map(r => [r.time, r.sessionId.slice(0, 8), r.tool, r.summary, r.ok ? 'ok' : r.error || 'fail', r.durationMs]), 'No tool calls yet.');
      byId('range').textContent = (page.history.length ? offset + 1 : 0) + '-' + (offset + page.history.length) + ' of ' + page.total;
      byId('prev').disabled = offset === 0; byId('next').disabled = !page.hasMore;
    }
    if (['api-docs', 'tools-skills'].includes(requestedView) && !apiCatalog) { apiCatalog = await request('/admin/api-docs'); renderApis(); renderCatalog(); }
    byId('auth').hidden = true; byId('stop').disabled = false; byId('notice').textContent = '';
  } catch (e) {
    metadata({ Status: 'Unavailable' }); byId('stop').disabled = true; byId('notice').textContent = e.message;
  } finally { busy = false; byId('refresh').disabled = false; }
}
function selectView() {
  const next = location.hash.slice(1); view = Object.hasOwn(viewNames, next) ? next : 'overview';
  for (const name of Object.keys(viewNames)) byId('view-' + name).hidden = name !== view;
  for (const link of document.querySelectorAll('.tree a')) { if (link.hash === '#' + view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
  byId('view-title').textContent = viewNames[view];
  document.body.classList.toggle('chat-view', view === 'chat');
  if (view === 'chat' && !byId('chat-frame').hasAttribute('src')) startChat();
  refresh();
}
window.addEventListener('hashchange', selectView);
byId('api-filter').oninput = renderApis;
byId('catalog-filter').oninput = renderCatalog;
byId('refresh').onclick = () => { stopped = false; refresh(); };
byId('auth').onsubmit = e => { e.preventDefault(); token = byId('token').value.trim(); byId('token').value = ''; refresh(); };
byId('copy').onclick = async () => { try { await navigator.clipboard.writeText(location.origin + '/mcp'); byId('notice').textContent = 'MCP URL copied.'; } catch { byId('notice').textContent = 'Could not copy URL.'; } };
byId('prev').onclick = () => { if (!busy) { offset = Math.max(0, offset - limit); refresh(); } };
byId('next').onclick = () => { if (!busy) { offset += limit; refresh(); } };
byId('stop').onclick = async () => {
  if (!confirm('Stop Keepwork MCP? Connected clients will disconnect.')) return;
  stopped = true; byId('stop').disabled = true;
  try { await request('/admin/stop', 'POST'); metadata({ Status: 'Stopped' }); byId('notice').textContent = 'Service stopped.'; }
  catch (e) { stopped = false; byId('stop').disabled = false; byId('notice').textContent = e.message; }
};
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
selectView();
</script></body></html>
"###;
