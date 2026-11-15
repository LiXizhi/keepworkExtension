// Installed only in the trusted main /chat document before application scripts.
(() => {
  const native = window.__keepworkPetTransport;
  delete window.__keepworkPetTransport;
  if (typeof native !== 'function' || window.aichatDesktop) return;
  const listeners = new Set();
  let connected = false, latest = null, latestState = null, pendingInput = null, confirmedInput = null, disposed = false;
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const flush = () => {
    if (connected && listeners.size && latest && !disposed) native('state', latest);
  };
  native('register', (kind, payload) => {
    if (disposed) return;
    if (kind === 'connect') {
      connected = native('connect', payload) === true;
      flush(); return;
    }
    if (kind !== 'command' || !connected) return;
    let command;
    try { command = JSON.parse(payload); } catch { return; }
    if (command.version !== 1 || !['input', 'send', 'stop', 'toggle-target'].includes(command.action)
        || !text(command.context, 160) || !text(command.requestId, 160)) return;
    if (command.action === 'input') {
      confirmedInput = null;
      pendingInput = { id: command.requestId, context: command.context, text: command.text };
    } else if (command.action === 'send') {
      const input = confirmedInput; confirmedInput = null;
      if (!input || input.context !== command.context || latestState?.context !== command.context || latestState.draft !== input.text) {
        native('result', JSON.stringify({ requestId: command.requestId, ok: false,
          error: '网页草稿已改变，尚未发送，请打开 AIChat 核查。' }));
        return;
      }
    }
    for (const listener of listeners) {
      try { Promise.resolve(listener(Object.freeze(command))).catch(() => {}); } catch { /* Independent listeners. */ }
    }
  });
  const bridge = Object.freeze({
    version: 1,
    capabilities: Object.freeze({ floatingPet: true, petTextChatVersion: 1 }),
    publishPetState(value) {
      if (disposed || value?.version !== 1 || !text(value.context, 160)) return Promise.reject(Error('无效宠物状态'));
      // Project text only. Never serialize artwork, audio, keys or arbitrary fields.
      const state = {
        version: 1, context: text(value.context, 160),
        target: value.target === 'chat' ? 'chat' : 'persona',
        title: text(value.title, 160), draft: text(value.draft, 32000),
        ready: value.ready === true, busy: value.busy === true,
        richDraft: value.richDraft === true, dictating: value.dictating === true,
        canSwitchTarget: value.canSwitchTarget === true,
        attention: text(value.attention, 2000), error: text(value.error, 2000),
        reply: text(value.reply?.text, 8000),
        messages: (Array.isArray(value.messages) ? value.messages : []).slice(-8)
          .filter(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
          .map(m => ({ role: m.role, content: text(m.content, 4000) })),
      };
      if (latestState && latestState.context !== state.context) { pendingInput = null; confirmedInput = null; }
      latestState = state; latest = JSON.stringify(state); flush(); return Promise.resolve();
    },
    onPetCommand(listener) {
      if (typeof listener !== 'function') throw TypeError('需要回调函数');
      listeners.add(listener); flush();
      return () => listeners.delete(listener);
    },
    petResult(result) {
      if (!disposed && connected && text(result?.requestId, 160)) {
        if (pendingInput?.id === result.requestId) {
          confirmedInput = result.ok === true ? pendingInput : null;
          pendingInput = null;
        }
        native('result', JSON.stringify({ requestId: text(result.requestId, 160),
          ok: result.ok === true, error: text(result.error, 2000) }));
      }
      return Promise.resolve();
    },
  });
  Object.defineProperty(window, 'aichatDesktop', { value: bridge, enumerable: false, configurable: false, writable: false });
  window.addEventListener('pagehide', () => {
    disposed = true; latest = latestState = pendingInput = confirmedInput = null; listeners.clear();
  }, { once: true });
})();
