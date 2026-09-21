export function dashboardHtml(): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Keepwork local MCP</title>
<style>
:root{color-scheme:light dark;font-family:"Segoe UI",sans-serif;color:light-dark(#242424,#ccc);background:light-dark(#fafafa,#1f1f1f)}
*{box-sizing:border-box}body{margin:0;padding:24px;max-width:1100px;margin-inline:auto;font-size:13px;line-height:1.6}h1{font-size:20px;margin:0 0 16px}h2{font-size:14px;margin:24px 0 8px}.toolbar,form,.pager{display:flex;gap:10px;align-items:center;flex-wrap:wrap}button,a,input{font:inherit}button,a{padding:6px 12px;border:1px solid #777;border-radius:3px;background:transparent;color:inherit;cursor:pointer}a{text-decoration:none}button:disabled{opacity:.45;cursor:default}input{padding:7px;max-width:100%;background:transparent;color:inherit;border:1px solid #777;border-radius:3px}form{margin-top:16px}form[hidden]{display:none}dl{display:grid;grid-template-columns:80px minmax(0,1fr);gap:3px 12px}dt{opacity:.7}dd{margin:0;overflow-wrap:anywhere}#notice{color:light-dark(#a32918,#ffb09f);min-height:1.6em}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:8px;border-bottom:1px solid #7775;vertical-align:top;overflow-wrap:anywhere;max-width:340px}th{white-space:nowrap}.empty{opacity:.65}.pager{margin-top:12px}.ok{color:light-dark(#15703b,#80ce9d)}.fail{color:light-dark(#ae261d,#ffb09f)}@media(max-width:600px){body{padding:16px}h1{font-size:18px}}
body{max-width:none;padding:0;display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh;background:light-dark(#fafafa,#1f1f1f)}aside{padding:24px 16px;border-right:1px solid #7774;background:light-dark(#f0f2f3,#252526)}.brand{font-size:16px;font-weight:650;margin-bottom:24px}.tree{display:grid;gap:4px}.tree a{display:block;border:0;padding:8px 12px}.tree a[aria-current="page"]{background:light-dark(#dcecf1,#124353);color:light-dark(#164d60,#bce8f4)}.tree details{margin-top:12px}.tree summary{padding:8px 12px;cursor:pointer}.tree details a{margin-left:14px;border-left:1px solid #7775;border-radius:0}main{padding:28px;min-width:0;max-width:1400px;width:100%}.view[hidden]{display:none}.api-item{border-top:1px solid #7774;padding:16px 0}.api-item summary{cursor:pointer;overflow-wrap:anywhere}.api-item pre{white-space:pre-wrap;overflow-wrap:anywhere;background:light-dark(#edf1f2,#292d2e);padding:12px}.api-item code{overflow-wrap:anywhere}#api-filter{width:100%;margin:12px 0}.muted{opacity:.65}@media(max-width:600px){body{padding:0;grid-template-columns:128px minmax(0,1fr)}aside{padding:16px 8px}.brand{font-size:14px}.tree a,.tree summary{padding:8px 6px}main{padding:16px 12px}h1{font-size:18px}.toolbar{gap:6px}.toolbar button,.toolbar a{padding:5px 7px}dl{grid-template-columns:1fr;gap:0}dd{margin-bottom:8px}}
body.chat-view main{padding:0;max-width:none;height:100dvh;display:flex;flex-direction:column;overflow:hidden}body.chat-view #view-title{display:none}body.chat-view #notice:empty{display:none}body.chat-view #notice{margin:0;padding:8px 12px}body.chat-view #auth{margin:0;padding:8px 12px}body.chat-view #view-chat{flex:1;min-height:0}#chat-frame{display:block;width:100%;height:100%;border:0;background:white}
</style></head><body>
<aside><div class="brand">Keepwork<br>local MCP</div><nav class="tree" aria-label="Dashboard navigation">
<a href="#overview">Overview / 概览</a><a href="#history">History</a><a href="#clients">Clients</a><a href="#paracrafts">Paracrafts</a>
<a href="#chat">AI 对话</a>
<details open><summary>Developer</summary><a href="#api-docs">API docs</a></details>
</nav></aside><main>
<h1 id="view-title">Overview / 概览</h1>
<form id="auth" hidden><label for="token">Pairing token</label><input id="token" type="password" autocomplete="off" required><button>Connect</button></form>
<p id="notice" role="status" aria-live="polite"></p>
<section class="view" id="view-overview">
<nav class="toolbar" aria-label="Service controls"><button id="refresh">Refresh</button><button id="copy">Copy MCP URL</button><a href="https://keepwork.com/chat" target="_blank" rel="noopener noreferrer">Open AIChat</a><button id="stop" disabled>Stop service</button></nav>
<dl id="meta"><dt>Status</dt><dd>Connecting...</dd></dl><h2>Clients</h2><div id="overview-clients" class="scroll"></div></section>
<section class="view" id="view-clients" hidden><div id="clients" class="scroll"></div></section>
<section class="view" id="view-history" hidden><div id="history" class="scroll"></div>
<div class="pager"><button id="prev" disabled>Newer</button><span id="range">0 of 0</span><button id="next" disabled>Older</button></div>
</section>
<section class="view" id="view-paracrafts" hidden><div id="paracrafts" class="scroll"></div><h2>Web Paracraft</h2><div id="webparacrafts" class="scroll"></div></section>
<section class="view" id="view-api-docs" hidden><p id="api-info"></p><label for="api-filter">Filter APIs</label><input id="api-filter" type="search" placeholder="Method, path, or description"><div id="api-docs"></div></section>
<section class="view" id="view-chat" hidden><iframe id="chat-frame" title="Keepwork MCP AI 对话" referrerpolicy="no-referrer" allow="clipboard-write"></iframe></section>
</main>
<script>
const byId = id => document.getElementById(id);
let token = '', offset = 0, busy = false, stopped = false, view = 'overview', apiCatalog = null;
const viewNames = {overview:'Overview / 概览',history:'History',clients:'Clients',paracrafts:'Paracrafts','api-docs':'API docs',chat:'AI 对话'};
function startChat() {
  const url = new URL('https://keepwork.com/chat');
  const params = {layout:'thin',chat:'new',persist:'0',frontpage:'hide',disable_automation:'1',hide:'sidebar,pet,share,history,search',skill:'keepwork-mcp-assistant',skillUrl:location.origin + '/dashboard/skills/keepwork-mcp-assistant/SKILL.md',skillName:'Keepwork MCP Assistant'};
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
  byId('chat-frame').src = url.href;
}
const limit = 20;
async function request(path, method = 'GET') {
  const response = await fetch(path, {method, cache:'no-store', headers:token ? {Authorization:'Bearer ' + token} : {}});
  if (response.status === 401) { byId('auth').hidden = false; throw new Error('Pairing token required. Use the token from ~/.keepwork-mcp/token.'); }
  if (!response.ok) throw new Error('Request failed (' + response.status + ')');
  return response.json();
}
function table(target, headings, rows, empty) {
  const container = byId(target); container.replaceChildren();
  if (!rows.length) { const paragraph = document.createElement('p'); paragraph.className = 'empty'; paragraph.textContent = empty; container.append(paragraph); return; }
  const element = document.createElement('table'), head = element.createTHead().insertRow();
  headings.forEach(label => { const cell = document.createElement('th'); cell.textContent = label; head.append(cell); });
  const body = element.createTBody();
  rows.forEach(values => { const row = body.insertRow(); values.forEach(value => { row.insertCell().textContent = String(value ?? ''); }); });
  container.append(element);
}
function metadata(values) {
  byId('meta').replaceChildren();
  Object.entries(values).forEach(([label,value]) => { const term = document.createElement('dt'), detail = document.createElement('dd'); term.textContent = label; detail.textContent = String(value); byId('meta').append(term,detail); });
}
async function refresh() {
  if (busy || stopped) return;
  busy = true; byId('refresh').disabled = true;
  const requestedView = view;
  try {
    const status = await request('/admin/status');
    metadata({Status:'Running', URL:location.origin + '/mcp', PID:status.pid, Port:status.port, Root:status.workspaceRoot, Uptime:Math.round(status.uptimeMs / 1000) + 's', Auth:status.requireAuth ? 'Token required' : 'Open (loopback only)'});
    const clientRows = status.clients.map(client => [client.sessionId.slice(0,8),client.origin,client.connectedAt,client.lastSeenAt,client.callCount]);
    for (const target of ['clients','overview-clients']) table(target,['Session','Origin','Connected','Last seen','Calls'],clientRows,'No connected AIChat sessions.');
    if (requestedView === 'history') {
    let page = await request('/admin/history?offset=' + offset + '&limit=' + limit);
    if (offset && offset >= page.total) { offset = Math.max(0, Math.floor((page.total - 1) / limit) * limit); page = await request('/admin/history?offset=' + offset + '&limit=' + limit); }
    table('history',['Time','Client','Tool','Summary','Result','ms'],page.history.map(row => [row.time,row.sessionId.slice(0,8),row.tool,row.summary,row.ok ? 'ok' : row.error || 'fail',row.durationMs]),'No tool calls yet.');
    byId('range').textContent = (page.history.length ? offset + 1 : 0) + '-' + (offset + page.history.length) + ' of ' + page.total;
    byId('prev').disabled = offset === 0; byId('next').disabled = !page.hasMore;
    }
    if (requestedView === 'paracrafts') {
      const [native, health] = await Promise.all([request('/paracraft/clients'),request('/health')]);
      table('paracrafts',['Client','Platform','World','PID'],native.clients.map(client => [client.clientId,client.platform,client.worldName || '-',client.pid]),'No connected desktop Paracraft clients.');
      table('webparacrafts',['Instance','Root'],health.webservers.map(server => [server.instance,server.root]),'No connected Web Paracraft instances.');
    }
    if (requestedView === 'api-docs' && !apiCatalog) { apiCatalog = await request('/admin/api-docs'); renderApis(); }
    byId('auth').hidden = true; byId('stop').disabled = false; byId('notice').textContent = '';
  } catch (error) {
    metadata({Status:'Unavailable'}); for (const target of ['clients','overview-clients','history','paracrafts','webparacrafts','api-docs']) byId(target).replaceChildren(); apiCatalog = null;
    byId('stop').disabled = true; byId('prev').disabled = true; byId('next').disabled = true; byId('range').textContent = '0 of 0'; byId('notice').textContent = error.message;
  } finally { busy = false; byId('refresh').disabled = false; if (view !== requestedView) refresh(); }
}
function renderApis() {
  if (!apiCatalog) return;
  byId('api-info').textContent = apiCatalog.description;
  const query = byId('api-filter').value.toLowerCase();
  byId('api-docs').replaceChildren();
  const entries = apiCatalog.endpoints.filter(entry => JSON.stringify(entry).toLowerCase().includes(query));
  for (const entry of entries) {
    const details = document.createElement('details'); details.className = 'api-item';
    const summary = document.createElement('summary'); summary.textContent = entry.method + ' ' + entry.path + '  |  ' + entry.group;
    const description = document.createElement('p'); description.textContent = entry.description;
    const auth = document.createElement('p'); auth.textContent = 'Auth: ' + entry.auth;
    const parameters = document.createElement('pre'); parameters.textContent = entry.parameters;
    const example = document.createElement('pre'); example.textContent = entry.example;
    details.append(summary,description,auth,parameters,example); byId('api-docs').append(details);
  }
  if (!entries.length) byId('api-docs').textContent = 'No matching APIs.';
}
function selectView() {
  const next = location.hash.slice(1); view = Object.hasOwn(viewNames,next) ? next : 'overview';
  for (const name of Object.keys(viewNames)) byId('view-' + name).hidden = name !== view;
  for (const link of document.querySelectorAll('.tree a')) { if (link.hash === '#' + view) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); }
  byId('view-title').textContent = viewNames[view];
  document.body.classList.toggle('chat-view', view === 'chat');
  if (view === 'chat' && !byId('chat-frame').hasAttribute('src')) startChat();
  refresh();
}
window.addEventListener('hashchange',selectView);
byId('api-filter').oninput = renderApis;
byId('refresh').onclick = () => { stopped = false; refresh(); };
byId('auth').onsubmit = event => { event.preventDefault(); token = byId('token').value.trim(); byId('token').value = ''; refresh(); };
byId('copy').onclick = async () => { try { await navigator.clipboard.writeText(location.origin + '/mcp'); byId('notice').textContent = 'MCP URL copied.'; } catch { byId('notice').textContent = 'Could not copy URL.'; } };
byId('prev').onclick = () => { if (!busy) { offset = Math.max(0,offset-limit); refresh(); } };
byId('next').onclick = () => { if (!busy) { offset += limit; refresh(); } };
byId('stop').onclick = async () => {
  if (!confirm('Stop Keepwork MCP? Connected clients will disconnect. Restart from VS Code or Local Helper.')) return;
  stopped = true; byId('stop').disabled = true;
  try { await request('/admin/stop','POST'); metadata({Status:'Stopped'}); byId('notice').textContent = 'Restart from VS Code or Local Helper, then refresh.'; }
  catch (error) { stopped = false; byId('stop').disabled = false; byId('notice').textContent = error.message; }
};
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
selectView();
</script></body></html>`;
}