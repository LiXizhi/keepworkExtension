export const dashboardCliStyles = `
body:has(#view-cli-accounts:not([hidden])) #notice:empty{display:none}
#view-cli-accounts .toolbar{gap:8px}#cli-summary{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}#cli-notice:empty{display:none}#cli-notice{font-size:12px;margin:10px 0}#cli-cards{margin-top:14px}.cli-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:10px}.cli-card{border:1px solid #7773;border-left:3px solid #879098;border-radius:8px;padding:10px 12px;min-width:0;background:light-dark(#fff,#252526)}.cli-card[data-status=online]{border-left-color:#269464}.cli-card[data-status=error]{border-left-color:#d25350}.cli-card[data-status=unknown],.cli-card[data-status=offline]{border-left-color:#bf8b2d}.cli-card[data-status=missing]{opacity:.7}.cli-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.cli-card h3{font-size:14px;margin:0;line-height:1.4}.cli-badge{display:inline-flex;align-items:center;gap:5px;border-radius:99px;padding:2px 8px;font-size:11px;font-weight:600;white-space:nowrap;color:light-dark(#56616c,#bdc5ce);background:light-dark(#edf0f3,#363b42)}.cli-badge:before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}.cli-online{color:light-dark(#176841,#9ce7bd);background:light-dark(#e5f5ec,#183f2e)}.cli-unknown,.cli-offline{color:light-dark(#855b08,#f3d18a);background:light-dark(#fff3d8,#483a21)}.cli-error{color:light-dark(#ac3432,#ffb3b0);background:light-dark(#fcebea,#4a292a)}.cli-checking{color:light-dark(#2465a3,#a5ceff);background:light-dark(#e9f2fc,#243d57)}.cli-identity{font-size:12px;color:light-dark(#606972,#b5bcc4);margin:5px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cli-card-footer{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:8px}.cli-card-footer .channel-actions{margin:0;gap:5px}.cli-card-footer button{font-size:11px;padding:2px 7px;border-color:#7775;border-radius:5px}.cli-card-footer details{font-size:11px;color:light-dark(#69737e,#b5bcc4);margin-left:auto}.cli-card-footer summary{cursor:pointer}.cli-card-footer details[open]{flex-basis:100%;margin-left:0}.cli-card-footer details p{margin:6px 0 0;overflow-wrap:anywhere}.cli-card-footer button:hover:not(:disabled){background:light-dark(#edf2f7,#353f49)}
#claude-config-panel{margin-top:18px;border:1px solid #7774;border-radius:8px;padding:16px;min-width:0}#claude-config-panel h2{font-size:17px;margin:0}#claude-config-panel p{font-size:12px;line-height:1.6}#claude-config-panel .toolbar{flex-wrap:wrap}#claude-config-notice:empty{display:none}#claude-config-notice{overflow-wrap:anywhere}.claude-profile-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #7773;min-width:0}.claude-profile-description{min-width:0;overflow-wrap:anywhere}.claude-profile-description strong{font-size:13px}.claude-profile-description p{margin:4px 0 0;color:light-dark(#606972,#b5bcc4)}.claude-profile-row .channel-actions{flex-shrink:0;flex-wrap:wrap}.claude-profile-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:12px 0}.claude-profile-grid label{display:flex;flex-direction:column;gap:5px;font-size:12px;min-width:0}.claude-profile-grid input,.claude-profile-grid select{box-sizing:border-box;width:100%;min-width:0}#claude-profile-form{border-top:1px solid #7774;margin-top:16px;padding-top:12px}#claude-profile-form h3{font-size:14px;margin:0 0 8px}#claude-profile-form details{margin:12px 0}#claude-profile-form summary{cursor:pointer;font-size:12px}@media(max-width:560px){#claude-config-panel{padding:12px}.claude-profile-grid{grid-template-columns:1fr}.claude-profile-row{align-items:flex-start;flex-direction:column;gap:6px}.claude-profile-row .channel-actions{margin:0}}
`;

/** Dashboard-owned account UI; transport/auth remains in the shared dashboard. */
export const dashboardCliHtml = `<section class="view" id="view-cli-accounts" hidden>
<div id="cli-summary" aria-live="polite"></div>
<div class="toolbar"><button id="cli-refresh">刷新列表</button><button id="cli-check-all">检测全部</button><label>分类 <select id="cli-filter"><option value="all">全部 CLI</option><option value="installed">已安装</option><option value="signed-in">在线</option><option value="signed-out">未登录</option><option value="unknown">待确认</option><option value="error">异常</option><option value="missing">未安装</option></select></label></div>
<p id="cli-notice" role="status" aria-live="polite"></p><div id="cli-cards" class="cli-grid"></div>
<section id="claude-config-panel" aria-labelledby="claude-config-title" hidden>
<div class="toolbar"><h2 id="claude-config-title">Claude 服务商配置</h2><button id="claude-config-close">关闭配置</button></div>
<p>配置仅用于 Keepwork Claude harness，支持 Anthropic 兼容接口。密钥只保存在本机，不改写全局 Claude 设置。</p>
<p>登录和登出仍管理本机原生 Claude 账号；服务商配置通过密钥认证。</p>
<p>仅影响之后启动的 Claude 进程；运行中的会话保持原配置。</p>
<p id="claude-profile-current"></p><p id="claude-config-notice" role="status" aria-live="polite"></p>
<div class="toolbar"><button id="claude-config-refresh">刷新配置</button><button id="claude-profile-new" disabled>新增配置</button><button id="claude-profile-native" disabled>使用本机默认配置</button></div>
<div id="claude-profile-list"></div>
<form id="claude-profile-form" autocomplete="off" hidden>
<h3 id="claude-profile-form-title">新增配置</h3>
<div class="claude-profile-grid">
<label>配置名称<input id="claude-profile-name" required maxlength="80" placeholder="例如：公司网关"></label>
<label>API 地址<input id="claude-profile-base-url" type="url" required maxlength="2048" placeholder="https://api.anthropic.com"></label>
<label>认证方式<select id="claude-profile-auth-type"><option value="authToken">Auth Token（Bearer）</option><option value="apiKey">API Key（x-api-key）</option></select></label>
<label>密钥<input id="claude-profile-secret" type="password" required maxlength="4096" autocomplete="new-password"><span id="claude-profile-secret-help">输入服务商提供的密钥；保存后不会显示。</span></label>
<label>默认模型（可选）<input id="claude-profile-model" maxlength="200" placeholder="使用 CLI 默认模型"></label>
</div>
<details><summary>高级模型映射（可选）</summary><div class="claude-profile-grid">
<label>Sonnet 模型<input id="claude-profile-sonnet-model" maxlength="200" placeholder="服务商的 Sonnet 模型 ID"></label>
<label>Opus 模型<input id="claude-profile-opus-model" maxlength="200" placeholder="服务商的 Opus 模型 ID"></label>
<label>Haiku 模型<input id="claude-profile-haiku-model" maxlength="200" placeholder="服务商的 Haiku 模型 ID"></label>
</div></details>
<div class="toolbar"><button id="claude-profile-save" type="submit">保存配置</button><button id="claude-profile-cancel" type="button">取消编辑</button></div>
</form></section>
<section id="cli-terminal-panel" hidden><h2 id="cli-terminal-title"></h2><p id="cli-terminal-help"></p><pre id="cli-command" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
<div class="toolbar"><button id="cli-next" hidden></button><button id="cli-complete">完成并检测账号</button><button id="cli-close">关闭终端</button></div>
<div id="cli-terminal" style="height:400px;min-width:0;margin-top:12px;background:#1f1f1f"></div></section></section>`;

export const dashboardCliScript = String.raw`
const cliOwner = crypto.randomUUID();
let cliCatalog = null, cliLoading = false, cliAllBusy = false, cliStarting = false;
const cliStates = new Map(), cliChecks = new Set();
let cliTerminal = null, cliAssets;
let claudeConfig = null, claudeConfigBusy = false, claudeConfigNeedsRefresh = false, claudeProfileEditing = null;
let claudeAccountGeneration = 0, claudeConfigWriting = false;
const cliCdn = 'https://cdn.keepwork.com/keepwork/cdn/aichat/vendor/xterm/';
async function cliRequest(path, method = 'GET', body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try { return await request(path, method, body, controller.signal); }
  catch (error) { if (controller.signal.aborted) throw new Error('CLI 请求超时，结果尚未确认；未自动重试。'); throw error; }
  finally { clearTimeout(timer); }
}
function cliMessage(text) { byId('cli-notice').textContent = text; }
function cliAccount(info) {
  if (info?.authenticated === false) return '未登录';
  if (info?.account?.type === 'apiKey') return 'API Key 认证';
  const account = info?.account;
  const name = [account?.username, account?.name, account?.email].find(x => typeof x === 'string' && x.trim());
  return name || (info?.authenticated === true ? '用户名未提供' : '用户名尚未确认');
}
function cliStatus(item, info, checking = false) {
  if (checking) return {key:'checking', label:'检测中', rank:1};
  if (!item.available) return {key:'missing', label:'未安装', rank:5};
  if (info?.error || info?.modelsError || info?.available === false) return {key:'error', label:'异常', rank:2};
  if (info?.authenticated === true && info?.available === true) return {key:'online', label:'在线', rank:0};
  if (info?.authenticated === false) return {key:'offline', label:'未登录', rank:3};
  return {key:'unknown', label:'待确认', rank:4};
}
function renderCliAccounts() {
  const host = byId('cli-cards'); host.replaceChildren();
  const filter = byId('cli-filter').value;
  const entries = Object.entries(cliCatalog || {}).map(([id,item]) => ({id,item,status:cliStatus(item,cliStates.get(id),cliChecks.has(id))})).sort((a,b) => a.status.rank-b.status.rank);
  const summaryHost = byId('cli-summary'); summaryHost.replaceChildren();
  for (const [key,label] of [['online','在线'],['unknown','待确认'],['checking','检测中'],['offline','未登录'],['error','异常'],['missing','未安装']]) {
    const count = entries.filter(row => row.status.key === key).length;
    if (!count && key !== 'online') continue;
    const chip = document.createElement('span'); chip.className = 'cli-badge cli-' + key; chip.textContent = count + ' ' + label; summaryHost.append(chip);
  }
  for (const {id, item, status} of entries) {
    const info = cliStates.get(id), checking = cliChecks.has(id);
    if (filter === 'installed' && !item.available || filter === 'signed-in' && status.key !== 'online' || filter === 'signed-out' && status.key !== 'offline' || filter === 'unknown' && !['unknown','checking'].includes(status.key) || filter === 'error' && status.key !== 'error' || filter === 'missing' && status.key !== 'missing') continue;
    const card = document.createElement('article'); card.className = 'cli-card'; card.dataset.cli = id; card.dataset.status = status.key;
    const head = document.createElement('div'); head.className = 'cli-card-head';
    const title = document.createElement('h3'); title.textContent = item.name;
    const state = document.createElement('span'); state.className = 'cli-badge cli-' + status.key; state.textContent = status.label;
    state.title = status.key === 'online' ? '已登录且连接检测通过；不是后台任务运行状态' : status.key === 'unknown' ? '尚未确认登录状态' : status.label;
    head.append(title,state);
    const identity = document.createElement('p'); identity.className = 'cli-identity'; identity.textContent = checking ? '' : cliAccount(info);
    identity.hidden = ['checking','unknown','missing','offline'].includes(status.key) || status.key === 'error' && ![info?.account?.username,info?.account?.name,info?.account?.email].some(Boolean); identity.title = identity.textContent;
    const details = document.createElement('details'), summary = document.createElement('summary'), body = document.createElement('p');
    summary.textContent = '详情'; body.textContent = [item.cli?.path, info?.modelsError, info?.error || item.error].filter(Boolean).join(' · '); details.append(summary, body);
    const actions = document.createElement('div'); actions.className = 'channel-actions';
    const add = (label, run, disabled) => { const button = document.createElement('button'); button.textContent = label; button.disabled = !!disabled; button.onclick = run; actions.append(button); };
    add('检测账号', () => checkCliAccount(id), checking || cliAllBusy || !item.available || cliStarting || !!cliTerminal || id === 'claude' && claudeConfigWriting);
    if (id === 'claude') { add('配置', () => openClaudeConfig(), false); actions.lastElementChild.id = 'claude-config-open'; }
    for (const [action, plan] of Object.entries(item.actions || {})) add(plan.label, () => openCliAccount(id, action), checking || cliAllBusy || cliStarting || !!cliTerminal);
    const footer = document.createElement('div'); footer.className = 'cli-card-footer'; footer.append(actions,details);
    card.append(head, identity, footer); host.append(card);
  }
  if (!host.children.length) host.textContent = '此分类暂无 CLI。';
  byId('cli-refresh').disabled = cliLoading || cliAllBusy || cliChecks.size > 0 || cliStarting || !!cliTerminal;
  byId('cli-check-all').disabled = !cliCatalog || cliAllBusy || cliChecks.size > 0 || cliStarting || !!cliTerminal;
}
async function loadCliAccounts() {
  if (cliLoading) return;
  cliLoading = true; renderCliAccounts();
  try { cliCatalog = await cliRequest('/agents/accounts'); cliStates.clear(); cliMessage(''); }
  catch (error) { cliMessage(error.message); }
  finally { cliLoading = false; renderCliAccounts(); }
}
async function checkCliAccount(id) {
  if (cliChecks.has(id) || id === 'claude' && claudeConfigWriting) return;
  const generation = claudeAccountGeneration;
  const current = () => id !== 'claude' || generation === claudeAccountGeneration;
  cliChecks.add(id); cliStates.delete(id); renderCliAccounts();
  try { const result = await cliRequest('/agents/backends?backend=' + encodeURIComponent(id) + '&refresh=1'); if (current()) cliStates.set(id, result[id]); }
  catch (error) { if (current()) { cliStates.set(id, { error: error.message }); cliMessage(error.message); } }
  finally { cliChecks.delete(id); renderCliAccounts(); }
}
function claudeConfigMessage(text) { byId('claude-config-notice').textContent = text; }
function acceptClaudeConfig(value) {
  if (value?.version !== 1 || !Array.isArray(value.profiles)) throw new Error('当前服务不支持此版本的 Claude 配置管理，请更新本机运行时。');
  claudeConfig = value;
}
function renderClaudeConfig() {
  const host = byId('claude-profile-list'); host.replaceChildren();
  const writeDisabled = claudeConfigBusy || claudeConfigNeedsRefresh;
  const active = claudeConfig?.profiles.find(profile => profile.id === claudeConfig.activeProfileId);
  byId('claude-profile-current').textContent = !claudeConfig ? '' : claudeConfig.activeProfileId === null ? '当前：本机默认配置' : '当前：' + (active?.name || '待刷新');
  for (const id of ['claude-config-refresh','claude-config-close']) byId(id).disabled = claudeConfigBusy;
  byId('claude-profile-new').disabled = writeDisabled || !claudeConfig;
  byId('claude-profile-native').disabled = writeDisabled || !claudeConfig || claudeConfig.activeProfileId === null;
  for (const control of byId('claude-profile-form').querySelectorAll('input,select,button')) control.disabled = writeDisabled;
  if (!claudeConfig) return;
  if (!claudeConfig.profiles.length) { host.textContent = '尚未保存服务商配置，当前使用本机默认设置。'; return; }
  for (const profile of claudeConfig.profiles) {
    const row = document.createElement('div'); row.className = 'claude-profile-row'; row.dataset.profileId = profile.id;
    const description = document.createElement('div'); description.className = 'claude-profile-description';
    const name = document.createElement('strong'); name.textContent = profile.name + (profile.id === claudeConfig.activeProfileId ? ' · 已启用' : '');
    const detail = document.createElement('p'); detail.textContent = [profile.baseUrl, profile.authType === 'apiKey' ? 'API Key' : 'Auth Token', profile.hasSecret ? '已保存密钥' : '未保存密钥', profile.model ? '默认模型：' + profile.model : 'CLI 默认模型'].join(' · ');
    description.append(name,detail);
    const actions = document.createElement('div'); actions.className = 'channel-actions';
    const add = (label, run, disabled) => { const button = document.createElement('button'); button.textContent = label; button.disabled = writeDisabled || !!disabled; button.onclick = run; actions.append(button); };
    add('启用', () => mutateClaudeConfig('/agents/claude/config/activate','POST',{profileId:profile.id},'配置已启用；之后启动的 Claude 进程将使用此配置。'),profile.id === claudeConfig.activeProfileId);
    add('编辑', () => editClaudeProfile(profile),false);
    add('删除', () => { if (confirm('删除配置“' + profile.name + '”？')) void mutateClaudeConfig('/agents/claude/config/profiles/' + encodeURIComponent(profile.id),'DELETE',undefined,'配置已删除。'); },profile.id === claudeConfig.activeProfileId);
    row.append(description,actions); host.append(row);
  }
}
function cancelClaudeProfile() {
  claudeProfileEditing = null; byId('claude-profile-form').reset(); byId('claude-profile-secret').value = ''; byId('claude-profile-form').hidden = true;
}
function editClaudeProfile(profile) {
  if (claudeConfigBusy || claudeConfigNeedsRefresh) return;
  cancelClaudeProfile(); claudeProfileEditing = profile?.id || null;
  byId('claude-profile-form-title').textContent = profile ? '编辑配置' : '新增配置';
  for (const [field,id] of [['name','name'],['baseUrl','base-url'],['authType','auth-type'],['model','model'],['sonnetModel','sonnet-model'],['opusModel','opus-model'],['haikuModel','haiku-model']]) byId('claude-profile-' + id).value = profile?.[field] || (field === 'authType' ? 'authToken' : field === 'baseUrl' ? 'https://api.anthropic.com' : '');
  byId('claude-profile-secret').required = !profile;
  byId('claude-profile-secret').placeholder = profile ? '留空保留已保存的密钥' : '输入密钥';
  byId('claude-profile-secret-help').textContent = profile ? '留空保留已保存的密钥；输入新值可替换。' : '输入服务商提供的密钥；保存后不会显示。';
  byId('claude-profile-form').hidden = false; byId('claude-profile-name').focus();
}
async function openClaudeConfig() {
  byId('claude-config-panel').hidden = false;
  byId('claude-config-panel').scrollIntoView({block:'nearest'});
  await loadClaudeConfig();
}
async function loadClaudeConfig() {
  if (claudeConfigBusy) return;
  claudeConfigBusy = true; claudeConfigMessage('正在读取配置…'); renderClaudeConfig();
  try { acceptClaudeConfig(await cliRequest('/agents/claude/config')); claudeConfigNeedsRefresh = false; claudeConfigMessage(''); }
  catch (error) { claudeConfig = null; cancelClaudeProfile(); claudeConfigMessage('Claude 配置管理暂不可用：' + error.message); }
  finally { claudeConfigBusy = false; renderClaudeConfig(); }
}
async function mutateClaudeConfig(path, method, body, message) {
  if (claudeConfigBusy || claudeConfigNeedsRefresh) return;
  claudeAccountGeneration++; cliStates.delete('claude'); claudeConfigWriting = true;
  claudeConfigBusy = true; claudeConfigMessage('正在保存…'); renderClaudeConfig(); renderCliAccounts();
  try {
    acceptClaudeConfig(await cliRequest(path,method,body)); cancelClaudeProfile();
    claudeConfigMessage(message + ' 保存配置不代表连接验证通过。');
  } catch (error) { claudeConfigNeedsRefresh = true; claudeConfigMessage(error.message + ' 未自动重试，已暂停配置修改；请先刷新配置确认实际结果。'); }
  finally { claudeConfigBusy = false; claudeConfigWriting = false; renderClaudeConfig(); renderCliAccounts(); }
}
byId('claude-config-close').onclick = () => { cancelClaudeProfile(); byId('claude-config-panel').hidden = true; };
byId('claude-config-refresh').onclick = loadClaudeConfig;
byId('claude-profile-new').onclick = () => editClaudeProfile(null);
byId('claude-profile-native').onclick = () => { void mutateClaudeConfig('/agents/claude/config/activate','POST',{profileId:null},'已恢复本机默认配置；之后启动的 Claude 进程将使用本机设置。'); };
byId('claude-profile-cancel').onclick = cancelClaudeProfile;
byId('claude-profile-form').onsubmit = event => {
  event.preventDefault(); if (claudeConfigBusy || claudeConfigNeedsRefresh) return;
  const body = {};
  for (const [field,id] of [['name','name'],['baseUrl','base-url'],['authType','auth-type'],['model','model'],['sonnetModel','sonnet-model'],['opusModel','opus-model'],['haikuModel','haiku-model']]) body[field] = byId('claude-profile-' + id).value.trim();
  const secret = byId('claude-profile-secret').value;
  if (secret) body.secret = secret;
  byId('claude-profile-secret').value = '';
  void mutateClaudeConfig('/agents/claude/config/profiles' + (claudeProfileEditing ? '/' + encodeURIComponent(claudeProfileEditing) : ''),claudeProfileEditing ? 'PATCH' : 'POST',body,'配置已保存。');
};
function loadCliTerminalAssets() {
  if (window.Terminal && window.FitAddon?.FitAddon) return Promise.resolve();
  if (!cliAssets) {
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = cliCdn + 'xterm-6.0.0.css'; document.head.append(style);
    const script = file => new Promise((resolve,reject) => { const el = document.createElement('script'); const fail = () => { clearTimeout(timer); el.remove(); reject(new Error('终端组件加载失败，请重试。')); }; const timer = setTimeout(fail, 15000); el.src = cliCdn + file; el.onload = () => { clearTimeout(timer); resolve(); }; el.onerror = fail; document.head.append(el); });
    cliAssets = script('xterm-6.0.0.js').then(() => script('addon-fit-0.11.0.js')).catch(error => { cliAssets = null; throw error; });
  }
  return cliAssets;
}
function writeCliInput(session, data) {
  session.chain = session.chain.then(async () => {
    if (cliTerminal !== session || session.closed || session.failed) return;
    await cliRequest('/terminal/sessions/' + encodeURIComponent(session.id) + '/input', 'POST', {data});
  }).catch(error => { session.failed = true; cliMessage('终端输入失败：' + error.message + '。未自动重发，请查看终端实际状态。'); });
  return session.chain;
}
async function pollCliTerminal(session) {
  if (cliTerminal !== session || session.closed) return;
  try {
    const result = await cliRequest('/terminal/sessions/' + encodeURIComponent(session.id) + '/output?cursor=' + session.cursor);
    if (cliTerminal !== session) return;
    if (result.reset) session.term.reset();
    if (result.output) session.term.write(result.output);
    session.cursor = result.cursor; session.closed = !!result.closed;
    if (session.closed) cliMessage('终端已退出。请点击“完成并检测账号”确认实际登录状态。');
    else session.timer = setTimeout(() => pollCliTerminal(session), 500);
  } catch (error) { cliMessage('读取终端失败：' + error.message); }
}
async function closeCliTerminal() {
  const session = cliTerminal;
  if (!session) return true;
  clearTimeout(session.timer); session.closed = true; session.observer?.disconnect();
  try { await cliRequest('/terminal/sessions/' + encodeURIComponent(session.id), 'DELETE'); }
  catch (error) { cliMessage('关闭终端失败：' + error.message + '。请重试关闭，暂不启动新操作。'); return false; }
  session.term.dispose(); cliTerminal = null; byId('cli-terminal-panel').hidden = true;
  renderCliAccounts(); return true;
}
async function openCliAccount(id, action) {
  if (cliStarting || cliTerminal) return;
  const item = cliCatalog[id], plan = item.actions[action];
  if (action === 'logout' && !confirm('确定登出 ' + item.name + '？这会改变本机 CLI 账号，可能影响之后的任务。')) return;
  cliStarting = true; cliStates.delete(id); renderCliAccounts(); cliMessage('正在打开原生账号终端…');
  try {
    await loadCliTerminalAssets();
    const created = await cliRequest('/terminal/sessions', 'POST', {cols:100,rows:24});
    const session = cliTerminal = {id:created.id, backend:id, cursor:0, closed:false, failed:false, chain:Promise.resolve(), term:new window.Terminal({cursorBlink:true,convertEol:false,fontSize:13,theme:{background:'#1f1f1f'}})};
    byId('cli-terminal-panel').hidden = false; byId('cli-terminal-title').textContent = item.name + ' · ' + plan.label;
    byId('cli-command').textContent = plan.command;
    byId('cli-terminal-help').textContent = plan.input ? '先等待原生 CLI 菜单出现，再点击下一步；方向键、回车及授权均可直接在终端操作。' : '在终端完成原生交互和浏览器授权；执行完毕后检测账号，命令发送不代表操作成功。';
    byId('cli-next').hidden = !plan.input;
    byId('cli-next').textContent = '已进入 CLI，输入 ' + (plan.input || '');
    byId('cli-next').onclick = () => { if (cliTerminal === session && !session.closed && !session.failed) { void writeCliInput(session, plan.input + '\r'); byId('cli-next').hidden = true; } };
    byId('cli-terminal').replaceChildren(); session.term.open(byId('cli-terminal'));
    const fit = new window.FitAddon.FitAddon(); session.term.loadAddon(fit);
    session.observer = new ResizeObserver(() => { if (cliTerminal !== session || session.closed || byId('view-cli-accounts').hidden) return; fit.fit(); void cliRequest('/terminal/sessions/' + encodeURIComponent(session.id) + '/resize', 'POST', {cols:session.term.cols,rows:session.term.rows}).catch(error => cliMessage(error.message)); });
    session.observer.observe(byId('cli-terminal'));
    session.term.onData(data => { void writeCliInput(session, data); }); session.term.focus();
    await writeCliInput(session, plan.command + '\r');
    void pollCliTerminal(session);
    if (!session.failed) cliMessage('命令已发送，等待原生终端输出。');
  } catch (error) { cliMessage(error.message); if (cliTerminal) await closeCliTerminal(); }
  finally { cliStarting = false; renderCliAccounts(); }
}
byId('cli-filter').onchange = renderCliAccounts;
byId('cli-refresh').onclick = loadCliAccounts;
byId('cli-check-all').onclick = async () => {
  if (cliAllBusy || cliTerminal || cliStarting) return;
  cliAllBusy = true; renderCliAccounts();
  try { for (const [id,item] of Object.entries(cliCatalog || {})) { if (item.available) await checkCliAccount(id); } }
  finally { cliAllBusy = false; renderCliAccounts(); }
};
byId('cli-close').onclick = () => { void closeCliTerminal(); };
byId('cli-complete').onclick = async () => { const id = cliTerminal?.backend; if (await closeCliTerminal() && id) await checkCliAccount(id); };
`;
