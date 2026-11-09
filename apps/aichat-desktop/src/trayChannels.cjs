const names = ['钉钉', '飞书', '微信'];
const labels = {
  unknown: ['❔', '状态未知'], idle: ['⚪', '未运行'], unbound: ['⚪', '未绑定'],
  listening: ['✅', '监听中'], monitoring: ['✅', '上次已连接 · 巡检开启'], verified: ['✅', '上次已连接 · 巡检关闭'],
  qr: ['⚠️', '等待扫码'], attention: ['⚠️', '需检查'], partial: ['⚠️', '部分连接需检查'],
  pending: ['⏳', '连接中'], auth: ['⚠️', '需授权'],
};

function bindingState(rows) {
  if (!Array.isArray(rows)) return 'unknown';
  if (!rows.length) return 'unbound';
  const states = rows.map(row => row?.status);
  const auth = states.some(s => ['needs-login', 'needs-authorization', 'authorization-error'].includes(s));
  const error = states.some(s => ['error', 'coordination-error', 'coordination-ineligible'].includes(s));
  const pending = states.some(s => ['connecting', 'reconnecting'].includes(s));
  if (states.includes('listening')) return auth || error || pending ? 'partial' : 'listening';
  if (auth) return 'auth';
  if (error) return 'attention';
  if (pending) return 'pending';
  return states.every(s => ['stopped', 'standby', 'waiting-client'].includes(s)) ? 'idle' : 'unknown';
}

function channelStates(snapshot) {
  const states = ['dingtalk', 'feishu'].map(channel => bindingState(
    Array.isArray(snapshot?.channels) && snapshot.channels.find(row => row?.channel === channel)?.bindings));
  const wechat = snapshot?.wechat;
  return [...states, ['qr', 'monitoring', 'verified', 'attention', 'unbound', 'idle'].includes(wechat) ? wechat : 'unknown'];
}

function describe(states) {
  return states.map((state, index) => labels[state][0] + ' ' + names[index] + '：' + labels[state][1]);
}

module.exports = { channelStates, describe };
