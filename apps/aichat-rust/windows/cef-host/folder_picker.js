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
    return element.isConnected && !element.hidden && !element.classList.contains('hidden')
      && getComputedStyle(element).display !== 'none';
  }
  function refreshIntro() {
    const ui = controls(), intro = document.getElementById('spacePickerLocalIntro');
    if (ui && ui.panel.contains(intro) && intro.textContent !== introText) intro.textContent = introText;
  }
  const discovery = new MutationObserver(refreshIntro);
  discovery.observe(document, { subtree: true, childList: true });
  refreshIntro();
  async function browse(event) {
    const button = event.target?.closest?.('#spacePickerLocalBrowse');
    const ui = controls();
    if (!event.isTrusted || !ui || button !== ui.browse || !visible(ui.modal) || !visible(ui.panel)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (pending || button.disabled || ui.use.disabled) return;
    pending = true; button.disabled = true;
    refreshIntro();
    const originalPath = ui.input.value;
    let stale = false;
    const changed = () => { stale = true; };
    const observer = new MutationObserver(changed);
    observer.observe(ui.modal, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'data-space-id', 'data-workspace-id'] });
    // Native UI normally blocks parent input, but scripted close/reopen or an
    // account/workspace change must also invalidate the result.
    ui.modal.addEventListener('input', changed, true);
    ui.modal.addEventListener('change', changed, true);
    const current = () => !disposed && !stale && observer.takeRecords().length === 0
      && visible(ui.modal) && visible(ui.panel) && controls()?.input === ui.input
      && ui.input.value === originalPath && !ui.use.disabled;
    try {
      const chosen = await bridge.pickFolder();
      if (!chosen?.path || !current()) return;
      observer.disconnect();
      ui.input.value = chosen.path;
      // Validation errors live inside the initially collapsed manual-path area.
      // Keep the selected path and any MCP failure visible while it is checked.
      const details = ui.error.closest('details');
      if (details) details.open = true;
      // The page owns verification, errors and edit/new-workspace semantics.
      // Dispatching input/change here would alter that existing edit state.
      ui.use.click();
    } catch (error) {
      if (current()) {
        const details = ui.error.closest('details');
        if (details) details.open = true;
        ui.error.textContent = error?.message || '无法打开系统文件夹选择器，请重试。';
        ui.error.style.display = '';
      }
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
