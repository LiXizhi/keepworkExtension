// Windows 7 does not ship glyphs for several AIChat menu Emoji. Use local SVG
// decorations in the legacy host; never rewrite labels, badges or user content.
(() => {
  if (!['/chat', '/chat/'].includes(location.pathname)) return;
  const installed = Symbol.for('keepwork.cef.menu-icons');
  if (document[installed]) return;
  Object.defineProperty(document, installed, { value: true });

  const selector = '#userMenuDropdown > button.user-menu-item, #fileMenuDropdown > button.file-menu-item';
  const drawings = {
    '👤': [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M4 21v-2a8 8 0 0 1 16 0v2' }]],
    '🗂': [['path', { d: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h18' }]],
    '📅': [['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }], ['path', { d: 'M8 3v4M16 3v4M3 11h18' }]],
    '⏰': [['circle', { cx: 12, cy: 13, r: 8 }], ['path', { d: 'M12 9v4l3 2M3 4l3-2M18 2l3 2M5 19l-2 3M19 19l2 3' }]],
    '⚙': [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'm9 3 1-1h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1Z' }]],
    '🎨': [['path', { d: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4 2 2 0 0 1 1-4h3a3 3 0 0 0 3-3c0-4-4-7-9-7Z' }], ['circle', { cx: 7, cy: 11, r: 0.6 }], ['circle', { cx: 10, cy: 7, r: 0.6 }], ['circle', { cx: 15, cy: 7, r: 0.6 }]],
    '🔑': [['circle', { cx: 8, cy: 8, r: 5 }], ['path', { d: 'm12 12 9 9M16 16l3-3M19 19l3-3' }]],
    '🚪': [['path', { d: 'M9 21H4V3h5M14 7l5 5-5 5M8 12h13' }]],
  };
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const decoratedText = new WeakMap();
  function decorate(button) {
    // The published menu has a bare text prefix. Skip future SVG/wrapper
    // structures rather than guessing which child is an icon or a username.
    if (button.querySelector('svg:not(.keepwork-menu-icon)')) return;
    const content = Array.from(button.childNodes).filter(node => node.nodeType !== 3 || node.data.trim());
    const existing = content[0]?.nodeType === 1 && content[0].matches('svg.keepwork-menu-icon') ? content[0] : null;
    const text = content[existing ? 1 : 0];
    if (!text || text.nodeType !== 3) return;
    // Our own mutations also reach the observer. A remaining label can itself
    // start with an Emoji (for example a username); strip it only on new input.
    if (existing && decoratedText.get(text) === text.data) return;
    const match = text.data.match(/^\s*(👤|🗂|📅|⏰|⚙|🎨|🔑|🚪)\uFE0F?\s+(?=\S)/u);
    if (!match) return;
    if (existing) {
      text.data = text.data.slice(match[0].length);
      decoratedText.set(text, text.data);
      return;
    }
    const svg = document.createElementNS(svgNamespace, 'svg');
    for (const [name, value] of Object.entries({
      class: 'keepwork-menu-icon', width: 16, height: 16, viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', focusable: 'false',
    })) svg.setAttribute(name, String(value));
    svg.style.cssText = 'display:inline-block;vertical-align:middle;flex:0 0 16px';
    for (const [tag, attributes] of drawings[match[1]]) {
      const shape = document.createElementNS(svgNamespace, tag);
      for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, String(value));
      svg.append(shape);
    }
    text.data = text.data.slice(match[0].length);
    decoratedText.set(text, text.data);
    button.insertBefore(svg, text);
  }
  function decorateTree(root) {
    if (root.nodeType === 1 && root.matches(selector)) decorate(root);
    root.querySelectorAll?.(selector).forEach(decorate);
  }
  decorateTree(document);
  // Menu text changes on auth/language refresh. Inspect only changed subtrees
  // instead of rescanning the document for each streamed chat token.
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const button = element?.closest(selector);
      if (button) decorate(button);
      for (const node of record.addedNodes) decorateTree(node);
    }
  });
  observer.observe(document, { childList: true, characterData: true, subtree: true });
  window.addEventListener('pagehide', event => {
    if (!event.persisted) observer.disconnect();
  }, { once: true });
})();
