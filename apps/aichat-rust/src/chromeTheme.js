// Shared by the local connection page and the injected main-frame chrome.
// Keep this dependency-free: bridge.rs embeds the same implementation.
export function mountDesktopTheme({ host, invoke }) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let lastThemeKey = "";

  const syncTheme = () => {
    if (!document.body) return;
    const body = document.body;
    const root = document.documentElement;
    const shell = !!window.__AICHAT_PAGE_CONNECTION__ || !!document.getElementById("startup");
    // The native backdrop already uses the saved theme. Do not paint or report
    // an OS-derived guess before the local page obtains the current snapshot.
    if (shell && root.dataset.theme !== "light" && root.dataset.theme !== "dark") {
      host.style.visibility = "hidden";
      return;
    }
    host.style.visibility = "visible";
    const cs = getComputedStyle(body);
    const token = (name) => cs.getPropertyValue(name).trim();
    const declared = body.dataset.theme || root.dataset.theme;
    const light = declared === "light" || body.classList.contains("light") || root.classList.contains("light");
    const dark = !light && (
      declared === "dark" || body.classList.contains("dark") || root.classList.contains("dark") ||
      (cs.colorScheme === "dark" ? true : cs.colorScheme === "light" ? false :
        // Older AIChat pages use the absence of body.light for dark mode.
        !!token("--bg-sidebar"))
    );
    const confirmed = light || declared === "dark" || body.classList.contains("dark") || root.classList.contains("dark") ||
      cs.colorScheme === "dark" || cs.colorScheme === "light" || !!token("--bg-sidebar");
    const defaults = dark
      ? { bg: "#18181f", text: "#d4d4dc", hover: "#282834", address: "#9a9aa8", pill: "#242430", menu: "#202028" }
      : { bg: "#f2f3f7", text: "#1a1a2e", hover: "#e2e6ef", address: "#4a4a5a", pill: "#e2e6ef", menu: "#ffffff" };

    // Custom properties can contain var()/color-mix() and live on body while
    // the shadow host lives under html. Resolve them in the page's CSS context
    // before copying colors across that boundary or passing them to canvas.
    const probe = document.createElement("span");
    probe.hidden = true;
    body.appendChild(probe);
    const color = (raw, fallback) => {
      if (!raw || !ctx) return fallback;
      probe.style.backgroundColor = fallback;
      probe.style.backgroundColor = raw;
      const resolved = getComputedStyle(probe).backgroundColor;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = fallback;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = resolved;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return "#" + [r, g, b].map(value => value.toString(16).padStart(2, "0")).join("");
    };
    const bg = color(token("--experience-rail-bg") || token("--bg-sidebar"), defaults.bg);
    const text = color(token("--text-primary"), defaults.text);
    host.style.setProperty("--chrome-bg", bg);
    host.style.setProperty("--chrome-text", text);
    host.style.setProperty("--chrome-hover", color(token("--bg-pill-hover"), defaults.hover));
    host.style.setProperty("--chrome-address", color(token("--text-secondary"), defaults.address));
    host.style.setProperty("--chrome-pill", color(token("--bg-pill"), defaults.pill));
    host.style.setProperty("--chrome-menu-bg", color(token("--bg-card"), defaults.menu));
    probe.remove();
    const simple = body.dataset.experience === "simple" && window.innerWidth > 768;
    host.style.setProperty("--chrome-surface-start", simple ? `calc(${token("--experience-rail-width") || "56px"} + 14px)` : "0px");

    const key = `${dark}:${bg}:${text}:${confirmed}`;
    if (key !== lastThemeKey) {
      lastThemeKey = key;
      void invoke("desktop_sync_theme", { dark, color: bg, symbolColor: text, confirmed }).catch(() => {});
    }
  };

  const mount = () => {
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    for (const target of [document.documentElement, document.body]) {
      if (target) observer.observe(target, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme", "data-experience", "data-skin"],
      });
    }
    for (const event of ["aichat:theme-changed", "aichat:skin-changed", "aichat:experience-changed"]) {
      // AIChat dispatches non-bubbling events on document. Keep the window
      // listener for clients which used the older dispatch target.
      document.addEventListener(event, syncTheme);
      window.addEventListener(event, syncTheme);
    }
    document.addEventListener("load", event => {
      if (event.target?.tagName === "LINK" || event.target?.tagName === "STYLE") syncTheme();
    }, true);
    window.addEventListener("load", syncTheme);
    window.addEventListener("resize", syncTheme);
  };
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}
