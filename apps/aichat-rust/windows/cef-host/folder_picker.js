// Adapter for published AIChat pages which predate the independent picker
// capability. Keep their existing MCP path verification and workspace binding.
(() => {
  const bridge = window.aichatDesktop;
  if (bridge?.capabilities?.nativeFolderPickerVersion !== 1 || typeof bridge.pickFolder !== 'function') return;
  let pending = false, disposed = false;
  const introText = '使用系统文件夹选择器连接本机工作空间。文件访问由本地 MCP 服务提供，也可手动填写路径。';
  function controls() {
    const modal = document.getElementById('spacePickerModal');
    const panel = document.getElementById('spacePickerLevelLocal');
    const browse = document.getElementById('spacePickerLocalBrowse');
    const input = document.getElementById('spacePickerLocalAbsPath');
    const use = document.getElementById('spacePickerLocalUse');
    const error = document.getElementById('spacePickerLocalAbsError');
    // An unknown future layout keeps its own behavior; do not guess how to bind.
    if (!modal || !panel || !modal.contains(panel) || !panel.contains(browse) || !panel.contains(input)
        || !panel.contains(use) || !panel.contains(error) || browse?.tagName !== 'BUTTON'
        || input?.tagName !== 'INPUT' || use?.tagName !== 'BUTTON' || input.readOnly) return null;
    return { modal, panel, browse, input, use, error };
  }
  function visible(element) {
    const css = getComputedStyle(element);
    return element.isConnected && !element.hidden && !element.classList.contains('hidden')
      && css.display !== 'none' && css.visibility !== 'hidden' && css.visibility !== 'collapse';
  }
  function refreshIntro() {
    const ui = controls(), intro = document.getElementById('spacePickerLocalIntro');
    if (ui && ui.panel.contains(intro) && intro.textContent !== introText) intro.textContent = introText;
  }
  function showError(ui, message) {
    const details = ui.error.closest('details');
    if (details) details.open = true;
    ui.error.textContent = message;
    ui.error.style.display = '';
  }
  const discovery = new MutationObserver(refreshIntro);
  discovery.observe(document, { subtree: true, childList: true });
  refreshIntro();
  async function browse(event) {
    const button = event.target?.closest?.('#spacePickerLocalBrowse');
    const ui = controls();
    if (!event.isTrusted || !ui || button !== ui.browse || !visible(ui.modal) || !visible(ui.panel)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (pending || button.disabled) return;
    if (ui.use.disabled) {
      showError(ui, '正在验证路径，请稍后重试选择文件夹。');
      return;
    }
    pending = true; button.disabled = true;
    refreshIntro();
    const originalPath = ui.input.value;
    const head = document.getElementById('spacePickerLocalHead');
    const originalHead = head?.textContent;
    let stale = false;
    const changed = () => { stale = true; };
    const sameControls = () => {
      const next = controls();
      return next && Object.keys(ui).every(key => next[key] === ui[key]);
    };
    function inspect(records) {
      for (const record of records) {
        const target = record.target;
        if (record.type === 'childList' && [...record.removedNodes].some(node =>
          Object.values(ui).some(control => node === control || node.contains(control)))) changed();
        // Retain evidence of a different edit target even if the page switches
        // back before delivery. Rewriting the same heading during preparation
        // remains harmless.
        if (head && target === head && record.type === 'childList'
            && [...record.addedNodes].some(node => node.textContent !== originalHead)) changed();
        if (head && head.contains(target) && record.type === 'characterData'
            && record.oldValue !== target.textContent) changed();
        if (record.type === 'attributes' && (target === ui.modal || target === ui.panel)) {
          const name = record.attributeName;
          if (name.startsWith('data-') && record.oldValue !== target.getAttribute(name)) changed();
          // Capture a close/reopen in the same task, before the observer runs.
          // Ordinary style changes and background health notices do not change
          // the owner of the native dialog.
          if (name === 'hidden' && record.oldValue !== null) changed();
          if (name === 'class' && /(?:^|\s)hidden(?:\s|$)/.test(record.oldValue || '')) changed();
          if (name === 'style') {
            const style = document.createElement('div').style;
            style.cssText = record.oldValue || '';
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') changed();
          }
        }
      }
      if (!visible(ui.modal) || !visible(ui.panel) || !sameControls()
          || head && (document.getElementById(head.id) !== head || head.textContent !== originalHead)) changed();
    }
    const observer = new MutationObserver(inspect);
    observer.observe(ui.modal, { subtree: true, childList: true, characterData: true, characterDataOldValue: true,
      attributes: true, attributeOldValue: true,
      attributeFilter: ['class', 'style', 'hidden', 'data-space-id', 'data-workspace-id', 'data-picker-mode'] });
    // Native UI normally blocks parent input, but scripted close/reopen or an
    // account/workspace change must also invalidate the result.
    ui.modal.addEventListener('input', changed, true);
    ui.modal.addEventListener('change', changed, true);
    const current = () => {
      inspect(observer.takeRecords());
      return !disposed && !stale && ui.input.value === originalPath;
    };
    const showChanged = () => {
      // Never put an old result or error in a closed/replaced workspace editor.
      // If the editor is still visible, explain why the user needs to retry.
      if (!disposed && visible(ui.modal) && visible(ui.panel) && sameControls())
        showError(ui, '工作空间或路径已变化，请重新选择文件夹。');
    };
    try {
      const chosen = await bridge.pickFolder();
      if (!chosen?.path) return;
      if (!current()) { showChanged(); return; }
      observer.disconnect();
      ui.input.value = chosen.path;
      // Validation errors live inside the initially collapsed manual-path area.
      // Keep the selected path and any MCP failure visible while it is checked.
      const details = ui.error.closest('details');
      if (details) details.open = true;
      // The page owns verification, errors and edit/new-workspace semantics.
      // Dispatching input/change here would alter that existing edit state.
      if (ui.use.disabled) showError(ui, '路径已选中，请等待当前验证结束后点击“验证路径并使用”。');
      else ui.use.click();
    } catch (error) {
      if (current()) showError(ui, error?.message || '无法打开系统文件夹选择器，请重试。');
      else showChanged();
    } finally {
      observer.disconnect();
      ui.modal.removeEventListener('input', changed, true);
      ui.modal.removeEventListener('change', changed, true);
      button.disabled = false; pending = false;
    }
  }
  window.addEventListener('click', browse, true);
  window.addEventListener('pagehide', () => {
    disposed = true; discovery.disconnect(); window.removeEventListener('click', browse, true);
  }, { once: true });
})();
