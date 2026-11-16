// Injected by the host before page scripts. The private token stays in this
// top-frame closure; only the exact local connection page receives recovery UI.
export function installPageConnection(token, shellUrl, onVerifiedEntry) {
  if (window !== window.top) return;
  const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, { ...args, token });
  if (window.location.href === shellUrl) {
    Object.defineProperty(window, "__AICHAT_PAGE_CONNECTION__", {
      value: Object.freeze({
        status: () => invoke("desktop_page_connection_status"),
        retry: (automatic = false) => invoke("desktop_retry_page_connection", { automatic }),
      }),
      configurable: false,
      writable: false,
    });
    return;
  }
  // Do not wait for images, tool frames, completed login or MCP connections.
  // Native Finished alone also fires for Windows network error documents.
  const url = window.location.href;
  const attempt = invoke("desktop_page_connection_attempt", { url });
  // Attach rejection handling immediately, even while DOM parsing is pending.
  const ticket = attempt.catch(() => null);
  // A menu can change the configured origin without rebuilding this WebView's
  // init script. Only the host-verified current entry may receive the one-shot
  // appearance fallback; ordinary pages and failed tickets remain untouched.
  if (typeof onVerifiedEntry === "function") {
    let live = true;
    const stopAppearance = () => { live = false; };
    window.addEventListener("pagehide", stopAppearance, { once: true });
    void ticket.then(generation => {
      window.removeEventListener("pagehide", stopAppearance);
      if (!live || window.location.href !== url || !Number.isSafeInteger(generation) || generation < 0) return;
      const root = document.getElementById("app");
      if (root && (root.childElementCount > 0 || !!root.textContent.trim())) return;
      onVerifiedEntry(url);
    }).catch(() => { window.removeEventListener("pagehide", stopAppearance); });
  }
  let live = true;
  let reporting = false;
  let observer;
  const cleanup = new Set();
  const stop = () => {
    live = false;
    observer?.disconnect();
    for (const remove of cleanup) remove();
    cleanup.clear();
    window.removeEventListener("pagehide", stop);
    document.removeEventListener("DOMContentLoaded", ready);
  };
  window.addEventListener("pagehide", stop, { once: true });
  const ready = () => {
    if (!live) return;
    const location = window.location;
    const knownAIChat = (location.origin === "https://keepwork.com" && location.pathname === "/chat")
      || (["127.0.0.1", "localhost"].includes(location.hostname) && location.pathname.endsWith("/AIChat.html"));
    const rendered = node => !!node && (node.childElementCount > 0 || !!node.textContent.trim());
    const visible = node => {
      if (!node || node.closest('[hidden], [aria-hidden="true"]')) return false;
      const style = window.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && node.getClientRects().length > 0;
    };
    const interactive = () => {
      const login = document.getElementById("loginPromptBar");
      if (visible(login) && login.querySelector('button:not([disabled])')) return true;
      return [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], .kw-login-overlay')]
        .some(node => visible(node) && node.querySelector('button:not([disabled]), input:not([disabled]), a[href]'));
    };
    const contentReady = () => {
      const root = knownAIChat ? document.getElementById("app") : null;
      if (!root) return true; // Older/custom entry documents retain their fallback.
      // Some startup branches await a user's login/replay choice. Reveal that
      // usable prompt instead of waiting for interaction in a hidden window.
      if (interactive()) return true;
      if (document.getElementById("startup-progress")) return false;
      const completed = document.documentElement.getAttribute("data-workbench-ready");
      if (completed !== null) return completed === "true" && rendered(root);
      // Published older pages may not declare workbench readiness. Retain a
      // content fallback, but never count a busy root or loading-only shell.
      if (!rendered(root) || root.getAttribute("aria-busy") === "true") return false;
      if ([...root.querySelectorAll(':scope > [role="progressbar"], :scope > [aria-busy="true"], :scope > .loading, :scope > .spinner')].some(visible)) return false;
      const shell = root.querySelector(".app-shell");
      const chat = document.getElementById("chatMessages");
      const pane = root.querySelector(".scenario-pane.active");
      return !shell || !chat || (pane && pane.id !== "paneChat") || rendered(chat)
        || visible(document.getElementById("externalToolStack"));
    };
    const watched = new Set();
    const listen = (target, event, callback) => {
      target.addEventListener(event, callback);
      cleanup.add(() => target.removeEventListener(event, callback));
    };
    const stylesReady = () => {
      let loaded = true;
      for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
        if (link.disabled || (link.media && !window.matchMedia(link.media).matches) || link.sheet) continue;
        loaded = false;
        if (!watched.has(link)) {
          watched.add(link);
          listen(link, "load", check);
          listen(link, "error", check);
        }
      }
      // Layout starts any fonts required by the prepared first screen. Hidden
      // WebViews can suspend rAF, so readiness must not depend on paint frames.
      if (loaded) document.documentElement.getBoundingClientRect();
      return loaded && document.fonts?.status !== "loading";
    };
    const check = () => {
      if (!live || reporting || window.location.href !== url || !contentReady() || !stylesReady()) return;
      reporting = true;
      void ticket.then(generation => {
        if (!live || window.location.href !== url || !Number.isSafeInteger(generation) || generation < 0) return;
        // DOM/style state may have changed while native verification was pending.
        if (!contentReady() || !stylesReady()) { reporting = false; return; }
        stop();
        return invoke("desktop_main_document_ready", { url, generation });
      }).catch(() => {});
    };
    observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["data-workbench-ready", "aria-busy", "hidden", "aria-hidden", "class", "style", "href", "rel", "media", "disabled"],
    });
    if (document.fonts) {
      listen(document.fonts, "loadingdone", check);
      listen(document.fonts, "loadingerror", check);
    }
    check();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready, { once: true });
  } else {
    ready();
  }
}
