// Injected by the host before page scripts. The private token stays in this
// top-frame closure; only the exact local connection page receives recovery UI.
export function installPageConnection(token, shellUrl) {
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
  // Do not wait for images, tool frames, login, MCP or a new AIChat API.
  // Native Finished alone also fires for Windows network error documents.
  const url = window.location.href;
  const attempt = invoke("desktop_page_connection_attempt", { url });
  // Attach rejection handling immediately, even while DOM parsing is pending.
  const ticket = attempt.catch(() => null);
  const reportReady = () => {
    void ticket.then(generation => {
      if (generation === null) return;
      return invoke("desktop_main_document_ready", { url, generation });
    }).catch(() => {});
  };
  const ready = () => {
    const location = window.location;
    const knownAIChat = (location.origin === "https://keepwork.com" && location.pathname === "/chat")
      || (["127.0.0.1", "localhost"].includes(location.hostname) && location.pathname.endsWith("/AIChat.html"));
    const root = knownAIChat ? document.getElementById("app") : null;
    const rendered = () => root.childElementCount > 0 || !!root.textContent.trim();
    if (!root || rendered()) {
      reportReady();
      return;
    }
    // Cached HTML can finish parsing while an asynchronous SDK/module fetch
    // fails. Watch only the known AIChat root's first content, then stop forever.
    const observer = new MutationObserver(() => {
      if (!rendered()) return;
      observer.disconnect();
      window.removeEventListener("pagehide", stop);
      reportReady();
    });
    const stop = () => observer.disconnect();
    window.addEventListener("pagehide", stop, { once: true });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready, { once: true });
  } else {
    ready();
  }
}
