// Scoped layout repair for the two AIChat session menus when Popover is
// polyfilled. Keep their DOM ancestry, listeners and capability checks intact.
(() => {
  if (!['/chat', '/chat/'].includes(location.pathname)) return;
  const active = new Map(), held = new WeakMap();
  let frame = 0;
  function override(state, node, name, value) {
    let properties = held.get(node);
    if (!properties) { properties = new Map(); held.set(node, properties); }
    let record = properties.get(name);
    if (!record) {
      record = { node, name, value: node.style.getPropertyValue(name),
        priority: node.style.getPropertyPriority(name), owners: new Set(), applied: '' };
      properties.set(name, record);
    }
    if (!record.owners.has(state)) { record.owners.add(state); state.records.push(record); }
    record.applied = value;
    node.style.setProperty(name, value, 'important');
  }
  function release(menu) {
    const state = active.get(menu);
    if (!state) return;
    active.delete(menu);
    for (const record of state.records.reverse()) {
      record.owners.delete(state);
      if (record.owners.size) continue;
      const { node, name } = record;
      // A page edit made during the menu interaction belongs to the page.
      if (node.style.getPropertyValue(name) === record.applied && node.style.getPropertyPriority(name) === 'important') {
        if (record.value) node.style.setProperty(name, record.value, record.priority);
        else node.style.removeProperty(name);
      }
      held.get(node)?.delete(name);
    }
  }
  function acquire(menu, pages) {
    if (active.has(menu)) return active.get(menu);
    const state = { records: [], pages, anchor: pages
      ? menu.parentElement?.querySelector('.session-tabs-list')
      : document.querySelector('.session-tab-add') };
    active.set(menu, state);
    // A fixed polyfilled popover remains inside the header. These properties
    // create a fixed containing block; ordinary overflow and layout stay as-is.
    for (let node = menu.parentElement; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      for (const name of ['backdrop-filter', '-webkit-backdrop-filter', 'filter', 'transform', 'perspective']) {
        const value = css.getPropertyValue(name);
        if (value && value !== 'none') override(state, node, name, 'none');
      }
      if (/(?:layout|paint|strict|content)/.test(css.contain)) override(state, node, 'contain', 'none');
      if (/(?:transform|filter|perspective)/.test(css.willChange)) override(state, node, 'will-change', 'auto');
    }
    return state;
  }
  function position(menu, state) {
    const width = Math.max(0, document.documentElement.clientWidth || innerWidth);
    const height = Math.max(0, document.documentElement.clientHeight || innerHeight);
    if (width < 17 || height < 17) return;
    override(state, menu, 'box-sizing', 'border-box');
    override(state, menu, 'max-width', `${width - 16}px`);
    override(state, menu, 'max-height', `${Math.max(1, Math.min(state.pages ? 420 : height, state.pages ? height * .6 : height, height - 16))}px`);
    if (state.pages) override(state, menu, 'width', `${Math.min(320, width - 16)}px`);
    else override(state, menu, 'min-width', `${Math.min(170, width - 16)}px`);
    // Read the trigger after releasing ancestor containing blocks: a skin may
    // have transformed the header as well as applying backdrop-filter.
    const anchor = state.anchor?.isConnected ? state.anchor.getBoundingClientRect() : null;
    const rect = menu.getBoundingClientRect();
    const desiredLeft = anchor ? state.pages ? anchor.right - rect.width : anchor.left : rect.left;
    let top = anchor ? anchor.bottom + 6 : rect.top;
    if (anchor && top + rect.height > height - 8 && anchor.top - 14 > height - anchor.bottom - 14)
      top = anchor.top - rect.height - 6;
    override(state, menu, 'left', `${Math.max(8, Math.min(desiredLeft, width - rect.width - 8))}px`);
    override(state, menu, 'top', `${Math.max(8, Math.min(top, height - rect.height - 8))}px`);
  }
  function update() {
    frame = 0;
    for (const [menu, state] of active) {
      if (!menu.isConnected || state.pages && !menu.matches(':popover-open')) release(menu);
      else position(menu, state);
    }
    for (const menu of document.querySelectorAll('body > .session-add-menu')) position(menu, acquire(menu, false));
  }
  function queue() { if (!frame) frame = requestAnimationFrame(update); }
  function toggled(event) {
    const menu = event.target;
    if (!(menu instanceof HTMLElement) || !menu.matches('.session-pages-menu[popover]')) return;
    if (event.newState === 'open') {
      const state = acquire(menu, true);
      queueMicrotask(() => {
        if (active.get(menu) !== state) return;
        if (menu.isConnected && menu.matches(':popover-open')) position(menu, state);
        else release(menu);
      });
    } else queueMicrotask(() => {
      if (!menu.isConnected || !menu.matches(':popover-open')) release(menu);
    });
  }
  function scrolled(event) {
    if (active.size && ![...active.keys()].some(menu => menu.contains(event.target))) queue();
  }
  document.addEventListener('beforetoggle', toggled, true);
  window.addEventListener('resize', queue);
  document.addEventListener('scroll', scrolled, true);
  const observer = new MutationObserver(records => {
    if (active.size || records.some(record => [...record.addedNodes].some(node => node instanceof Element &&
      (node.matches('.session-add-menu') || node.querySelector('.session-add-menu'))))) queue();
  });
  observer.observe(document, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => {
    observer.disconnect(); cancelAnimationFrame(frame);
    for (const menu of active.keys()) release(menu);
    document.removeEventListener('beforetoggle', toggled, true);
    window.removeEventListener('resize', queue);
    document.removeEventListener('scroll', scrolled, true);
  }, { once: true });
})();
