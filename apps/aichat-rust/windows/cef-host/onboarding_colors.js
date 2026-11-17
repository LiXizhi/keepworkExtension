// CEF109 lacks color-mix(). With var(), unsupported colors invalidate the
// background at computed-value time, so earlier solid declarations cannot win.
// Keep the onboarding opaque and its white primary labels readable without
// changing layout, page state, or browsers that support the published styles.
(() => {
  if (!['/chat', '/chat/'].includes(location.pathname)) return;
  if (window.CSS?.supports?.('color', 'color-mix(in srgb, black, white)')) return;
  const id = 'keepwork-onboarding-colors';
  function install() {
    if (!document.head) return false;
    if (!document.getElementById(id)) {
      const style = document.createElement('style');
      style.id = id;
      // The host runs before page styles. Important backgrounds keep this
      // bounded fallback effective when lazy-loaded onboarding CSS arrives.
      // Alert cards already have a supported, purpose-specific button color.
      style.textContent = `
        .brain-onboarding { background:var(--bg-base,#fff)!important; }
        .brain-onboarding .bo-sidebar { background:var(--bg-sidebar,var(--bg-base,#fff))!important; }
        .brain-onboarding .bo-primary:not(.bo-setup-alert .bo-primary) { background:var(--accent,#6366f1)!important; }
      `;
      document.head.append(style);
    }
    return true;
  }
  if (install()) return;
  // OnContextCreated precedes even <head>. Observe only until it exists, then
  // CSS variables handle later theme changes without DOM scans or polling.
  const observer = new MutationObserver(() => {
    if (install()) dispose();
  });
  function dispose() {
    observer.disconnect();
    window.removeEventListener('pagehide', dispose);
  }
  observer.observe(document, { childList: true, subtree: true });
  window.addEventListener('pagehide', dispose, { once: true });
})();
