// One-shot compatibility for AIChat pages which restore appearance only after
// packages/SDK boot. The page's own theme controls take over immediately after.
export function installPageTheme(entryUrl) {
  if (window !== window.top) return;
  if (window.__AICHAT_PAGE_CONNECTION__) return;
  let page, entry;
  try {
    page = new URL(window.location.href);
    entry = new URL(entryUrl || "https://keepwork.com/chat");
  } catch { return; }
  const clean = url => ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  const published = page.origin === "https://keepwork.com" && page.pathname === "/chat";
  if (!clean(page) || !clean(entry) || (!published && (page.origin !== entry.origin || page.pathname !== entry.pathname))) return;
  const marker = Symbol.for("keepwork.desktop.page-theme");
  if (document[marker]) return;
  Object.defineProperty(document, marker, { value: true });

  const query = page.searchParams;
  const hash = new URLSearchParams(page.hash.slice(1));
  const explicit = String(query.has("theme") ? query.get("theme") : hash.get("theme") || "").trim().toLowerCase();
  let mode = "auto", stored = "";
  try { mode = window.localStorage.getItem("aichat:theme-mode") === "manual" ? "manual" : "auto"; } catch {}
  try { stored = window.localStorage.getItem("aichat:theme") || ""; } catch {}
  const hour = new Date().getHours();
  const theme = explicit === "light" || explicit === "dark" ? explicit
    : mode === "manual" ? (stored === "dark" ? "dark" : "light")
    : hour >= 7 && hour < 19 ? "light" : "dark";

  let style;
  let finished = false;
  const observer = new MutationObserver(() => apply());
  const stop = () => {
    finished = true;
    observer.disconnect();
    document.removeEventListener("DOMContentLoaded", apply);
    window.removeEventListener("pagehide", stop);
    document.documentElement?.removeAttribute("data-aichat-desktop-boot-theme");
    style?.remove();
  };
  const apply = () => {
    if (finished || !document.documentElement) return;
    if (!style) {
      // Even a slow stylesheet must not expose the old page's default canvas
      // while its body is still being parsed. Remove this before page takeover.
      document.documentElement.setAttribute("data-aichat-desktop-boot-theme", theme);
      style = document.createElement("style");
      style.textContent = `:root[data-aichat-desktop-boot-theme] { background: ${theme === "light" ? "#ffffff" : "#181818"}; color-scheme: ${theme}; }`;
      (document.head || document.documentElement).appendChild(style);
    }
    if (!document.body) return;
    document.body.classList.toggle("light", theme === "light");
    stop();
  };
  observer.observe(document, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  window.addEventListener("pagehide", stop, { once: true });
  apply();
}
