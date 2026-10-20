const labels = { idle: '尚未检查', checking: '正在检查…', available: '发现新版本', downloading: '正在下载…', ready: '已下载，可以更新', 'pending restart': '已下载，可以更新', applying: '正在更新…', current: '已是最新版本', error: '更新失败', unavailable: '开发环境不支持桌面更新' };
function date(value) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '未提供'; }
function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function render(snapshot) {
  const root = document.getElementById('components'); root.replaceChildren();
  document.getElementById('check').disabled = snapshot.checking;
  for (const [key, title, buttonLabel] of [['mcp', 'Keepwork MCP Server', '更新 MCP'], ['desktop', 'AIChat Desktop', '更新桌面应用']]) {
    const data = snapshot[key]; const card = document.createElement('section'); card.append(text('h2', title));
    const list = document.createElement('dl');
    const values = [['当前安装版本', data.currentVersion || '未知'], ['远端最新版本', data.latest?.version || '尚未获取'],
      [key === 'mcp' ? '构建日期' : '发布日期', date(key === 'mcp' ? data.latest?.builtAt : data.latest?.releaseDate)]];
    if (key === 'mcp' && data.owner !== 'desktop') values.push(['正在运行', `${data.runningVersion || '未知'}（${data.owner || '未连接'}）`]);
    for (const [label, value] of values) list.append(text('dt', label), text('dd', value));
    card.append(list);
    if (data.state === 'downloading') { const progress = document.createElement('progress'); progress.max = 100; progress.value = data.progress || 0; card.append(progress); }
    const row = document.createElement('div'); row.className = 'actions';
    const status = text('span', `${labels[data.state] || data.state}${data.stale ? '（显示上次检查结果）' : ''}${data.error ? '\n' + data.error : ''}`); status.className = 'status';
    const button = text('button', buttonLabel); button.disabled = !data.canApply;
    button.addEventListener('click', () => run(() => window.updates[key]()));
    row.append(status, button); card.append(row); root.append(card);
  }
}
async function run(action) { try { await action(); } catch (error) { document.querySelector('footer').textContent = error.message; } }
document.getElementById('check').addEventListener('click', () => run(() => window.updates.check()));
window.updates.subscribe(render);
void window.updates.status().then(render);
