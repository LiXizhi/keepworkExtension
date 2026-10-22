import { dashboardCliHtml, dashboardCliScript, dashboardCliStyles } from './dashboardCli';
export function dashboardHtml(): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Keepwork local MCP</title>
<style>
:root{color-scheme:light dark;font-family:"Segoe UI",sans-serif;color:light-dark(#242424,#ccc);background:light-dark(#fafafa,#1f1f1f)}
*{box-sizing:border-box}body{margin:0;padding:24px;max-width:1100px;margin-inline:auto;font-size:13px;line-height:1.6}h1{font-size:20px;margin:0 0 16px}h2{font-size:14px;margin:24px 0 8px}.toolbar,form,.pager{display:flex;gap:10px;align-items:center;flex-wrap:wrap}button,a,input{font:inherit}button,a{padding:6px 12px;border:1px solid #777;border-radius:3px;background:transparent;color:inherit;cursor:pointer}a{text-decoration:none}button:disabled{opacity:.45;cursor:default}input{padding:7px;max-width:100%;background:transparent;color:inherit;border:1px solid #777;border-radius:3px}form{margin-top:16px}form[hidden]{display:none}dl{display:grid;grid-template-columns:80px minmax(0,1fr);gap:3px 12px}dt{opacity:.7}dd{margin:0;overflow-wrap:anywhere}#notice{color:light-dark(#a32918,#ffb09f);min-height:1.6em}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:8px;border-bottom:1px solid #7775;vertical-align:top;overflow-wrap:anywhere;max-width:340px}th{white-space:nowrap}.empty{opacity:.65}.pager{margin-top:12px}.ok{color:light-dark(#15703b,#80ce9d)}.fail{color:light-dark(#ae261d,#ffb09f)}@media(max-width:600px){body{padding:16px}h1{font-size:18px}}
body{max-width:none;padding:0;display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh;background:light-dark(#fafafa,#1f1f1f)}aside{padding:24px 16px;border-right:1px solid #7774;background:light-dark(#f0f2f3,#252526)}.brand{font-size:16px;font-weight:650;margin-bottom:24px}.tree{display:grid;gap:4px}.tree a{display:block;border:0;padding:8px 12px}.tree a[aria-current="page"]{background:light-dark(#dcecf1,#124353);color:light-dark(#164d60,#bce8f4)}.tree details{margin-top:12px}.tree summary{padding:8px 12px;cursor:pointer}.tree details a{margin-left:14px;border-left:1px solid #7775;border-radius:0}main{padding:28px;min-width:0;max-width:1400px;width:100%}.view[hidden]{display:none}.api-item{border-top:1px solid #7774;padding:16px 0}.api-item summary{cursor:pointer;overflow-wrap:anywhere}.api-item pre{white-space:pre-wrap;overflow-wrap:anywhere;background:light-dark(#edf1f2,#292d2e);padding:12px}.api-item code{overflow-wrap:anywhere}#api-filter{width:100%;margin:12px 0}.muted{opacity:.65}@media(max-width:600px){body{padding:0;grid-template-columns:128px minmax(0,1fr)}aside{padding:16px 8px}.brand{font-size:14px}.tree a,.tree summary{padding:8px 6px}main{padding:16px 12px}h1{font-size:18px}.toolbar{gap:6px}.toolbar button,.toolbar a{padding:5px 7px}dl{grid-template-columns:1fr;gap:0}dd{margin-bottom:8px}}
body.chat-view main{padding:0;max-width:none;height:100dvh;display:flex;flex-direction:column;overflow:hidden}body.chat-view #view-title{display:none}body.chat-view #notice:empty{display:none}body.chat-view #notice{margin:0;padding:8px 12px}body.chat-view #auth{margin:0;padding:8px 12px}body.chat-view #view-chat{flex:1;min-height:0}#chat-frame{display:block;width:100%;height:100%;border:0;background:white}
@media(min-width:601px){#meta{grid-template-columns:180px minmax(0,1fr)}}
.channel-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:10px;align-items:start}.channel-card{border:1px solid #7774;border-radius:8px;padding:10px 12px;min-width:0}.channel-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.channel-card h3{margin:0 auto 0 0;font-size:14px}.channel-account{margin:4px 0;color:light-dark(#666,#aaa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.channel-card dl{grid-template-columns:90px minmax(0,1fr)}.channel-card details{font-size:12px}.channel-card summary{cursor:pointer;color:light-dark(#666,#aaa);width:fit-content}.channel-card details[open]{margin-top:8px}.channel-badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap;color:light-dark(#626970,#aeb5bc)}.channel-badge:before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}.channel-badge.connected{color:light-dark(#15703b,#80ce9d)}.channel-badge.warning{color:light-dark(#946200,#edc56b)}.channel-badge.error{color:light-dark(#ae261d,#ffb09f)}.channel-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:6px 0 10px;font-size:12px}.channel-controls label{display:flex;align-items:center;gap:5px}.channel-actions{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}.channel-actions button{font-size:12px;padding:2px 8px}.channel-help{font-size:12px;margin:0 0 10px}.channel-help summary{cursor:pointer;opacity:.65}.channel-help p{margin:4px 0}.im-serving{border:1px solid #7774;border-radius:8px;padding:10px 12px;margin:0 0 12px}.im-serving p{margin:0}.im-brain{font-weight:650;overflow-wrap:anywhere}.im-serving-line{overflow-wrap:anywhere}

${dashboardCliStyles}
</style></head><body>
<aside><div class="brand">Keepwork<br>local MCP</div><nav class="tree" aria-label="Dashboard navigation">
<a href="#overview">Overview / 概览</a><a href="#history">History</a><a href="#clients">Clients</a><a href="#paracrafts">Paracrafts</a>
<a href="#instance-messaging">Instance Messaging</a><a href="#cli-accounts">CLI 账号</a><a href="#personas">Personas / 分身</a><a href="#chat">AI 对话</a>
<details open><summary>Developer</summary><a href="#api-docs">API docs</a><a href="#tools-skills">Tools &amp; skills</a></details>
</nav></aside><main>
<h1 id="view-title">Overview / 概览</h1>
<form id="auth" hidden><label for="token">Pairing token</label><input id="token" type="password" autocomplete="off" required><button>Connect</button></form>
<p id="notice" role="status" aria-live="polite"></p>
<section class="view" id="view-overview">
<nav class="toolbar" aria-label="Service controls"><button id="refresh">Refresh</button><button id="copy">Copy MCP URL</button><a href="https://keepwork.com/chat" target="_blank" rel="noopener noreferrer">Open AIChat</a><button id="stop" disabled>Stop service</button></nav>
<h2>服务信息</h2><dl id="meta"><dt>Status</dt><dd>Connecting...</dd></dl><h2>Clients</h2><div id="overview-clients" class="scroll"></div></section>
<section class="view" id="view-instance-messaging" hidden><div id="im-serving" class="im-serving"><p class="im-brain">当前第二大脑：正在读取…</p></div><h2>通讯渠道</h2><div class="channel-controls"><label><input id="follow-im-clients" type="checkbox" disabled> 随客户端自动监督</label><span class="muted">每 5 分钟检查</span></div><details class="channel-help"><summary>监督设置说明</summary><p class="muted">本机默认开启：客户端进程运行且 CLI 授权有效时，恢复已启用的分身；这不代表桌面客户端已登录。关闭后，分身可独立运行。授权时间由 CLI 提供，每分钟更新。</p><p id="supervisor-status" class="muted"></p></details><div id="channel-status" class="channel-grid" aria-live="polite">正在读取渠道状态…</div></section>
<section class="view" id="view-clients" hidden><div id="clients" class="scroll"></div></section>
<section class="view" id="view-history" hidden><div id="history" class="scroll"></div>
<div class="pager"><button id="prev" disabled>Newer</button><span id="range">0 of 0</span><button id="next" disabled>Older</button></div>
</section>
<section class="view" id="view-paracrafts" hidden><div id="paracrafts" class="scroll"></div><h2>Web Paracraft</h2><div id="webparacrafts" class="scroll"></div></section>
<section class="view" id="view-api-docs" hidden><p>HTTP APIs, authentication, parameters and JavaScript fetch examples.</p><label for="api-filter">Filter APIs</label><input id="api-filter" type="search" placeholder="Method, path, or description"><div id="api-docs"></div></section>
<section class="view" id="view-tools-skills" hidden><p>Built-in MCP tool calls, skills and skill references. Expand an entry to inspect its input schema or resource URI.</p><label for="catalog-filter">Filter tools and skills</label><input id="catalog-filter" type="search" placeholder="Name or description" style="width:100%;margin:12px 0"><div id="tools-skills"></div></section>
<section class="view" id="view-personas" hidden><p id="persona-stats"></p><h2>Personas</h2><div id="personas" class="scroll"></div><h2>Managed sessions</h2><p class="muted">MCP conversation contexts and currently retained execution sessions. Completed execution sessions may be cleaned up.</p><div id="persona-sessions" class="scroll"></div><h2>最近渠道消息 / Recent messages</h2><p class="muted">本次运行最多保留实际收到的 500 条，重启清空。内容与回复各显示最多 8000 字符；回复是否送达请查看状态。</p><label for="messages-filter">消息范围 </label><select id="messages-filter"><option value="all">全部收到</option><option value="related">与我有关（私聊、@我、命中代答规则）</option></select><div id="persona-messages" class="scroll"></div><div class="pager"><button id="messages-prev">上一页</button><span id="messages-range"></span><button id="messages-next">下一页</button></div></section>
${dashboardCliHtml}
<section class="view" id="view-chat" hidden><iframe id="chat-frame" title="Keepwork MCP AI 对话" referrerpolicy="no-referrer" allow="clipboard-write"></iframe></section>
</main>
<script>
const byId = id => document.getElementById(id);
let token = '', offset = 0, busy = false, stopped = false, view = 'overview', apiCatalog = null;
const viewNames = {'instance-messaging':'Instance Messaging','cli-accounts':'CLI 状态与账号',personas:'Personas / 分身',overview:'Overview / 概览',history:'History',clients:'Clients',paracrafts:'Paracrafts','api-docs':'API docs','tools-skills':'Tools & skills',chat:'AI 对话'};
function startChat(channel = '') {
  let url = new URL('https://keepwork.com/chat');
  const override = new URLSearchParams(location.search).get('aichat');
  if (override) {
    try {
      const candidate = new URL(override);
      const local = ['127.0.0.1', 'localhost'].includes(candidate.hostname);
      if (candidate.username || candidate.password || !((local && ['http:', 'https:'].includes(candidate.protocol)) || candidate.origin === 'https://keepwork.com')) throw new Error('Invalid AIChat URL');
      url = candidate;
    } catch {
      byId('notice').textContent = 'AIChat 地址必须是 localhost / 127.0.0.1 的 HTTP(S) 地址或 https://keepwork.com。';
      return;
    }
  }
  const skill = {skill:'keepwork-mcp-assistant',skillUrl:location.origin + '/dashboard/skills/keepwork-mcp-assistant/SKILL.md'+(['dingtalk','feishu'].includes(channel)?'?channel='+channel:''),skillName:'Keepwork MCP Assistant'};
  const params = {layout:'thin',chat:'new',persist:'0',frontpage:'hide',disable_automation:'1',hide:'sidebar,pet,share,history,search',...skill};
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
  byId('chat-frame').src = url.href;
}
let recentMessages = [], messageOffset = 0;
function messageContent(value) {
  const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');
  summary.textContent=String(value||'—').slice(0,100);body.textContent=value||'—';body.style.whiteSpace='pre-wrap';
  details.append(summary,body);return details;
}
function routeText(route, active) {
  if (!route || !route.server) return '尚未确定';
  const kinds = { cli: 'CLI', client: 'AIChat 客户端', headless: '无界面 AIChat' };
  const ai = kinds[route.server] || route.server;
  const named = route.server === 'cli' && route.executor ? ai + ' · ' + route.executor : ai;
  const model = route.model || (route.server === 'cli' ? '默认模型' : '—');
  return named + ' · 模型 ' + model + (active ? ' · 正在回复' : '');
}
function renderMessages() {
  const filtered=recentMessages.filter(m=>m.direction!=='out'&&(byId('messages-filter').value==='all'||m.relevant));
  messageOffset=Math.min(messageOffset,Math.max(0,Math.floor((filtered.length-1)/50)*50));
  const rows=filtered.slice(messageOffset,messageOffset+50);
  const states={ignored:'已忽略',queued:'排队中',running:'处理中',sending:'发送中',done:'已回复',sent:'已发送',unknown:'结果未知',cancelled:'已取消',error:'失败',rejected:'已拒绝'};
  table('persona-messages',['时间','渠道 / 分身 / 账号','会话 / 发送者','状态','收到的内容','回复内容'],rows.map(m=>[
    new Date(m.time).toLocaleString(),m.channel+' / '+(m.persona||'—')+' / '+m.profile,
    m.conversation+' / '+m.sender,(states[m.state]||m.state)+(m.reason?' · '+m.reason:'')+(m.server?' · '+routeText(m,false):(m.executor?' · '+m.executor:'')),messageContent(m.text),messageContent(m.reply)
  ]),'本次运行尚未收到或处理渠道消息。');
  byId('messages-range').textContent=(rows.length?messageOffset+1:0)+'–'+(messageOffset+rows.length)+' / '+filtered.length+'（收到 '+recentMessages.length+' / 最多 500）';
  byId('messages-prev').disabled=messageOffset===0;byId('messages-next').disabled=messageOffset+50>=filtered.length;
}
byId('messages-filter').onchange=()=>{messageOffset=0;renderMessages();};
byId('messages-prev').onclick=()=>{messageOffset=Math.max(0,messageOffset-50);renderMessages();};
byId('messages-next').onclick=()=>{messageOffset+=50;renderMessages();};
const limit = 20;
async function request(path, method = 'GET', body, signal) {
  const response = await fetch(path, {method, signal, cache:'no-store', headers:{...(path.startsWith('/agents/') ? {'X-Agent-Owner':cliOwner} : {}),...(token ? {Authorization:'Bearer ' + token} : {}),...(body ? {'Content-Type':'application/json'} : {})},body:body ? JSON.stringify(body) : undefined});
  if (response.status === 401) { byId('auth').hidden = false; throw new Error('Pairing token required. Use the token from ~/.keepwork-mcp/token.'); }
  if (!response.ok) {const detail=await response.json().catch(()=>({}));throw Object.assign(new Error(detail.error||('Request failed (' + response.status + ')')),detail);}
  return response.json();
}
${dashboardCliScript}
function table(target, headings, rows, empty) {
  const container = byId(target); container.replaceChildren();
  if (!rows.length) { const paragraph = document.createElement('p'); paragraph.className = 'empty'; paragraph.textContent = empty; container.append(paragraph); return; }
  const element = document.createElement('table'), head = element.createTHead().insertRow();
  headings.forEach(label => { const cell = document.createElement('th'); cell.textContent = label; head.append(cell); });
  const body = element.createTBody();
  rows.forEach(values => { const row = body.insertRow(); values.forEach(value => { const cell=row.insertCell();if(value instanceof Node)cell.append(value);else cell.textContent=String(value ?? ''); }); });
  container.append(element);
}
function metadata(values) {
  byId('meta').replaceChildren();
  Object.entries(values).forEach(([label,value]) => { const term = document.createElement('dt'), detail = document.createElement('dd'); term.textContent = label; detail.textContent = String(value); byId('meta').append(term,detail); });
}
function displayDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, {timeZoneName:'short'}) : 'Unknown / 未提供';
}
function serverMetadata(status) {
  const unknown = 'Unknown / 未提供';
  const hosts = {'vscode-extension':'VS Code / Cursor 扩展','local-helper':'KP Local Helper','standalone':'Standalone / 独立运行时','electron-node-runtime':'AIChat Desktop / NodeRuntime'};
  return {
    Status:'Running',
    'MCP version / 版本':status.runtimeVersion || unknown,
    'Built at / 构建时间':displayDate(status.runtimeBuiltAt),
    'Source / 服务来源':Object.hasOwn(hosts, status.hostKind) ? hosts[status.hostKind] : status.hostKind || unknown,
    'Host version / 宿主版本':status.hostVersion || 'Not reported / 未提供',
    'Git commit / 提交':status.runtimeCommit || unknown,
    'Service API version':status.version || unknown,
    URL:location.origin + '/mcp',
    'Entry / 启动文件':status.entryPath || unknown,
    'Executable / 执行程序':status.execPath || unknown,
    'Node.js':status.nodeVersion || unknown,
    Platform:[status.platform, status.arch].filter(Boolean).join(' / ') || unknown,
    PID:status.pid, Port:status.port, Root:status.workspaceRoot,
    'Started at / 启动时间':displayDate(status.startedAt),
    Uptime:Math.round(status.uptimeMs / 1000) + 's',
    Auth:status.requireAuth ? 'Token required' : 'Open (loopback only)',
  };
}
const channelActions=new Set();
function channelHelp(channel){startChat(channel);location.hash='chat';}
function renderImServing(channels) {
  const box=byId('im-serving');box.replaceChildren();
  const names={dingtalk:'钉钉',feishu:'飞书'};
  const roots=[...new Set(channels.map(channel=>channel.root).filter(Boolean))];
  const brain=document.createElement('p');brain.className='im-brain';
  if(!roots.length)brain.textContent='当前第二大脑：未绑定';
  else if(roots.length===1){brain.textContent='当前第二大脑：'+roots[0];brain.title=roots[0];}
  else{brain.textContent='当前第二大脑：'+channels.filter(channel=>channel.root).map(channel=>(names[channel.channel]||channel.channel)+' '+channel.root).join('；');brain.title=roots.join('\\n');}
  box.append(brain);
  for(const channel of channels){
    const line=document.createElement('p');line.className='im-serving-line';
    const binding=(channel.bindings||[]).find(row=>row.enabled&&row.serving)||(channel.bindings||[]).find(row=>row.serving)||null;
    const serving=binding&&binding.serving;
    let text=(names[channel.channel]||channel.channel)+'：'+routeText(serving,!!(serving&&serving.active));
    if(serving&&serving.next&&serving.next.server)text+='（下次：'+routeText(serving.next,false)+'）';
    line.textContent=text;if(channel.root)line.title=channel.root;box.append(line);
  }
}
function renderChannels(channels) {
  renderImServing(channels);
  const target=byId('channel-status');const expanded=new Set([...target.querySelectorAll('details[open]')].map(el=>el.dataset.channel));target.replaceChildren();
  const names={active:'已登录',ready:'已登录',expired:'已过期',missing:'未登录',unknown:'未知',listening:'监听中',stopped:'已停止',error:'异常',retrying:'等待重试','waiting-client':'等待客户端运行或 CLI 授权'};
  function date(value){if(!value)return 'CLI 未提供';const remaining=new Date(value).getTime()-Date.now();return new Date(value).toLocaleString()+'（'+(remaining<=0?'已过期':'剩余 '+Math.ceil(remaining/3600000)+' 小时')+'）';}
  for(const channel of channels){
    const card=document.createElement('article');card.className='channel-card';
    const head=document.createElement('div');head.className='channel-head';
    const title=document.createElement('h3');title.textContent=channel.channel==='dingtalk'?'钉钉':'飞书';head.append(title);
    function badge(text,tone){const el=document.createElement('span');el.className='channel-badge '+tone;el.textContent=text;head.append(el);}
    const listening=channel.bindings.filter(b=>b.status==='listening').length;
    const failed=channel.bindings.some(b=>b.status==='error');
    const waiting=channel.bindings.some(b=>b.enabled&&b.status!=='listening');
    if(listening)badge('监听中'+(listening>1?' · '+listening:''),'connected');
    else if(failed)badge('连接异常','error');
    else if(waiting)badge('等待连接','warning');
    else badge(channel.installed?'未连接':'未安装','');
    const expired=channel.accounts.some(a=>a.status==='expired'||(a.expiresAt&&new Date(a.expiresAt).getTime()<=Date.now()));
    if(expired)badge('授权过期','warning');
    else if(channel.error&&channel.installed)badge('授权待检查','warning');
    else if(channel.accounts.length&&!channel.accounts.some(a=>['active','ready'].includes(a.status)))badge('未登录','');
    card.append(head);
    const brainLine=document.createElement('p');brainLine.className='channel-brain';brainLine.style.overflowWrap='anywhere';brainLine.textContent='第二大脑：'+(channel.root||'未绑定');brainLine.title=channel.root||'';card.append(brainLine);
    const accountLine=document.createElement('p');accountLine.className='channel-account';
    accountLine.textContent=channel.accounts.map(a=>[a.name,a.organization].filter(Boolean).join(' · ')||'已配置账号').join('、')||'未登录账号';accountLine.title=accountLine.textContent;card.append(accountLine);
    const actions=document.createElement('div');actions.className='channel-actions';
    for(const binding of channel.bindings){
      const action=document.createElement('button');
      action.textContent=binding.enabled?'断开连接':binding.transitioning?'断开中…':'连接';
      action.title=(binding.enabled?'停止此分身的监听和自动回复，不退出 CLI 登录':'连接已配置的分身')+' · '+binding.profile;
      action.disabled=!binding.id||channelActions.has(binding.id)||(!binding.enabled&&binding.transitioning);
      action.onclick=async()=>{
        channelActions.add(binding.id);action.disabled=true;
        try{await request('/admin/channels/connection','POST',{id:binding.id,action:binding.enabled?'disconnect':'connect'});}
        catch(error){
          if(error.code==='CHANNEL_OCCUPIED'&&error.occupiedRoot!==error.requestedRoot&&confirm(error.error+'\\n切换会停止原目录的监听和自动回复。')) {
            try {await request('/admin/channels/connection','POST',{id:binding.id,action:'connect',switchFromRoot:error.occupiedRoot});}
            catch(next){byId('notice').textContent=next.message;}
          } else byId('notice').textContent=error.message;
        }
        finally{channelActions.delete(binding.id);await refreshChannels();}
      };actions.append(action);
    }
    const help=document.createElement('button');help.textContent=channel.bindings.length?'AIChat 排查':'连接设置';
    help.title=channel.bindings.length?'打开内置 AIChat 排查此渠道':'打开内置 AIChat，选择分身并配置连接';help.onclick=()=>channelHelp(channel.channel);actions.append(help);card.append(actions);
    const details=document.createElement('details');details.dataset.channel=channel.channel;details.open=expanded.has(channel.channel);
    const more=document.createElement('summary');more.textContent='详情';details.append(more);
    const summary=document.createElement('p');summary.textContent=(channel.channel==='dingtalk'?'dingtalk-cli':'lark-cli')+' · '+(channel.installed?'CLI 已安装':'CLI 未安装');details.append(summary);
    function row(list,key,value){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=value;list.append(dt,dd);}
    for(const account of channel.accounts){const list=document.createElement('dl');row(list,'账号',[account.name,account.organization,account.profile].filter(Boolean).join(' / '));row(list,'登录状态',names[account.status]||account.status);row(list,'Access token',date(account.expiresAt));row(list,'Refresh token',date(account.refreshExpiresAt));details.append(list);}
    if(!channel.accounts.length){const note=document.createElement('p');note.textContent=channel.error||'未发现个人登录账号';details.append(note);}
    else if(channel.error){const note=document.createElement('p');note.className='fail';note.textContent=channel.error;details.append(note);}
    for(const binding of channel.bindings){const list=document.createElement('dl');row(list,'绑定账号',binding.profile);row(list,'监听状态',names[binding.status]||binding.status);row(list,'自动回复',binding.enabled?'已启用':'已关闭');if(binding.lastPollAt)row(list,'最近收件检查',new Date(binding.lastPollAt).toLocaleString());details.append(list);}
    if(!channel.bindings.length){const note=document.createElement('p');note.textContent='未绑定分身 · 自动回复未启用';details.append(note);}
    const checked=document.createElement('small');checked.textContent='授权检查：'+new Date(channel.checkedAt).toLocaleString();details.append(checked);card.append(details);target.append(card);
  }
}
let supervisorSaving=false;
function renderSupervisor(state){
  if(!state||supervisorSaving)return;
  byId('follow-im-clients').checked=state.enabled;byId('follow-im-clients').disabled=false;
  const clients=state.clients||{};
  byId('supervisor-status').textContent=(clients.error||('钉钉进程：'+(clients.dingtalk?'运行中':'未运行')+'；飞书进程：'+(clients.feishu?'运行中':'未运行')))+(clients.checkedAt?' · 最近检查：'+new Date(clients.checkedAt).toLocaleString():' · 等待首次检查')+(state.accounts||[]).map(a=>' · '+a.profile+' CLI 授权：'+(a.authorized?'有效':'不可用')).join('');
}
byId('follow-im-clients').onchange=async()=>{
  supervisorSaving=true;byId('follow-im-clients').disabled=true;
  try{await request('/admin/channels/supervisor','POST',{enabled:byId('follow-im-clients').checked});}
  catch{byId('notice').textContent='自动监督设置保存失败，请重试。';}
  finally{supervisorSaving=false;await refreshChannels();}
};
async function refreshChannels(){try{const data=await request('/admin/channels');renderChannels(data.channels||[]);renderSupervisor(data.supervisor);}catch{byId('im-serving').textContent='当前第二大脑：读取失败';byId('channel-status').textContent='渠道状态读取失败，请检查服务或登录授权。';}}
async function refresh() {
  if (busy || stopped) return;
  busy = true; byId('refresh').disabled = true;
  const requestedView = view;
  try {
    const status = await request('/admin/status');
    metadata(serverMetadata(status));
    if(requestedView==='instance-messaging')void refreshChannels();
    const clientRows = status.clients.map(client => [client.sessionId.slice(0,8),client.origin,client.connectedAt,client.lastSeenAt,client.callCount]);
    for (const target of ['clients','overview-clients']) table(target,['Session','Origin','Connected','Last seen','Calls'],clientRows,'No connected AIChat sessions.');
    if (requestedView === 'history') {
    let page = await request('/admin/history?offset=' + offset + '&limit=' + limit);
    if (offset && offset >= page.total) { offset = Math.max(0, Math.floor((page.total - 1) / limit) * limit); page = await request('/admin/history?offset=' + offset + '&limit=' + limit); }
    table('history',['Time','Client','Tool','Summary','Result','ms'],page.history.map(row => [row.time,row.sessionId.slice(0,8),row.tool,row.summary,row.ok ? 'ok' : row.error || 'fail',row.durationMs]),'No tool calls yet.');
    byId('range').textContent = (page.history.length ? offset + 1 : 0) + '-' + (offset + page.history.length) + ' of ' + page.total;
    byId('prev').disabled = offset === 0; byId('next').disabled = !page.hasMore;
    }
    if (requestedView === 'personas') {
      const data = await request('/admin/personas');
      const incomingMessages=data.recentMessages||[];
      if(JSON.stringify(incomingMessages)!==JSON.stringify(recentMessages)||!byId('messages-range').textContent){recentMessages=incomingMessages;renderMessages();}
      byId('persona-stats').textContent = data.stats.total + ' personas · ' + data.stats.active + ' active · ' + data.stats.messages + ' messages · ' + data.stats.enabledSchedules + ' enabled schedules · ' + data.stats.sessions + ' managed sessions';
      table('personas',['Name','ID','State','Executor','Model','Messages','Unread','Schedules (enabled/total)','Channels','Last message'],data.personas.map(p=>[p.name,p.id,p.state,p.executor,p.model,p.messages,p.unread,p.enabledSchedules + '/' + p.schedules,p.channels,p.lastMessageAt ? new Date(p.lastMessageAt).toLocaleString() : '-']),'No personas managed by this service.');
      table('persona-sessions',['Persona','Session','Kind','Backend','State'],data.sessions.map(s=>[s.persona,s.id,s.kind,s.backend,s.state]),'No managed sessions.');
    }
    if (requestedView === 'paracrafts') {
      const [native, health] = await Promise.all([request('/paracraft/clients'),request('/health')]);
      table('paracrafts',['Client','Platform','World','PID'],native.clients.map(client => [client.clientId,client.platform,client.worldName || '-',client.pid]),'No connected desktop Paracraft clients.');
      table('webparacrafts',['Instance','Root'],health.webservers.map(server => [server.instance,server.root]),'No connected Web Paracraft instances.');
    }
    if (['api-docs','tools-skills'].includes(requestedView) && !apiCatalog) { apiCatalog = await request('/admin/api-docs'); renderApis(); renderCatalog(); }
    byId('auth').hidden = true; byId('stop').disabled = false; byId('notice').textContent = '';
  } catch (error) {
    metadata({Status:'Unavailable'}); for (const target of ['clients','overview-clients','history','paracrafts','webparacrafts','api-docs','tools-skills','personas','persona-sessions','persona-stats']) byId(target).replaceChildren(); apiCatalog = null;
    byId('stop').disabled = true; byId('prev').disabled = true; byId('next').disabled = true; byId('range').textContent = '0 of 0'; byId('notice').textContent = error.message;
  } finally { busy = false; byId('refresh').disabled = false; if (view !== requestedView) refresh(); }
}
function renderCatalog() {
  if (!apiCatalog) return;
  const query = byId('catalog-filter').value.toLowerCase();
  byId('tools-skills').replaceChildren();
  let matches = 0;
  for (const [key, title] of [['tools','Built-in MCP tool calls'],['skills','Built-in skills'],['references','Skill references']]) {
    const all = apiCatalog[key] || [];
    const rows = all.filter(entry => JSON.stringify(entry).toLowerCase().includes(query));
    if (!rows.length) continue;
    matches += rows.length;
    const heading = document.createElement('h2'); heading.textContent = title + ' (' + rows.length + '/' + all.length + ')'; byId('tools-skills').append(heading);
    for (const entry of rows) {
      const article = document.createElement('article'); article.className = 'api-item catalog-' + key;
      const name = document.createElement('strong'); name.textContent = entry.name;
      const description = document.createElement('p'); description.textContent = (entry.uri && entry.uri.startsWith('keepwork://skills/agent-cli-verify/') ? 'Second Brain configuration only · Not advertised to normal MCP sessions. ' : '') + (entry.description || 'No description provided.');
      article.append(name, description);
      const details = document.createElement('details'), summary = document.createElement('summary'), content = document.createElement('pre');
      summary.textContent = key === 'tools' ? 'Input schema' : 'Resource URI';
      content.textContent = key === 'tools' ? JSON.stringify(entry.inputSchema, null, 2) : entry.uri;
      details.append(summary, content); article.append(details); byId('tools-skills').append(article);
    }
  }
  if (!matches) byId('tools-skills').textContent = 'No matching tools or skills.';
}
function renderApis() {
  if (!apiCatalog) return;
  const query = byId('api-filter').value.toLowerCase();
  byId('api-docs').replaceChildren();
  const entries = apiCatalog.endpoints.filter(entry => JSON.stringify(entry).toLowerCase().includes(query));
  if (entries.length) { const heading = document.createElement('h2'); heading.textContent = 'HTTP APIs (' + entries.length + '/' + apiCatalog.endpoints.length + ')'; byId('api-docs').append(heading); }
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
  if (view === 'cli-accounts' && !cliCatalog) void loadCliAccounts();
  if (view === 'chat' && !byId('chat-frame').hasAttribute('src')) startChat();
  refresh();
}
window.addEventListener('hashchange',selectView);
byId('api-filter').oninput = renderApis;
byId('catalog-filter').oninput = renderCatalog;
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
