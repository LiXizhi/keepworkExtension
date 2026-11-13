// WKWebView blocks HTTPS -> HTTP loopback as mixed content. Keep the browser's
// transport everywhere else; the native handler independently verifies the
// actual main frame, source and destination before opening a local request.
export function installLocalMcpFetch({ platform, entryUrl }) {
  if (platform !== "darwin" || window !== window.top) return false;
  const handler = window.webkit?.messageHandlers?.keepworkLocalMcp;
  if (typeof handler?.postMessage !== "function") return false;
  const trusted = (raw) => {
    try {
      const page = new URL(window.location.href), entry = new URL(raw);
      return page.protocol === "https:" && !page.username && !page.password
        && !entry.username && !entry.password && page.origin === entry.origin
        && page.pathname.replace(/\/$/, "") === entry.pathname.replace(/\/$/, "");
    } catch { return false; }
  };
  if (!trusted("https://keepwork.com/chat") && !trusted(entryUrl)) return false;
  const originalFetch = window.fetch;
  const documentId = crypto.randomUUID();
  const active = new Set();
  const maxBody = 32 * 1024 * 1024;
  const abortError = () => new DOMException("The operation was aborted.", "AbortError");
  const encode = (bytes) => {
    let text = "";
    for (let at = 0; at < bytes.length; at += 32768) {
      text += String.fromCharCode(...bytes.subarray(at, at + 32768));
    }
    return btoa(text);
  };
  const decode = (text) => Uint8Array.from(atob(text), char => char.charCodeAt(0));
  const localTarget = (input) => {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      return url.protocol === "http:" && !url.username && !url.password && url.port === "8089"
        && ["localhost", "127.0.0.1"].includes(url.hostname);
    } catch { return false; }
  };
  const decorate = (response, url) => {
    Object.defineProperties(response, {
      url: { value: url }, redirected: { value: false }, type: { value: "cors" },
    });
    const clone = response.clone.bind(response);
    response.clone = () => decorate(clone(), url);
    return response;
  };

  window.fetch = async function (input, init) {
    if (!localTarget(input)) return originalFetch.call(this, input, init);
    const request = new Request(input, init);
    const endpoint = new URL(request.url);
    endpoint.hash = ""; // Fragments never belong to an HTTP request target.
    if (request.signal.aborted) throw request.signal.reason || abortError();
    if (request.credentials === "include" || request.mode === "no-cors" || request.mode === "same-origin"
        || request.redirect === "manual" || request.integrity) {
      throw new TypeError("本机 MCP 原生连接不支持此请求的凭据、模式、手动重定向或完整性选项。");
    }
    const id = crypto.randomUUID();
    const post = async (op, values = {}) => {
      try { return await handler.postMessage({ op, id, document: documentId, ...values }); }
      catch (error) { throw new TypeError(String(error)); }
    };
    let stopped = false, failure, controller, bodyReader;
    let rejectAbort;
    const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
    // A cancellation can happen between reads, with no pending race to observe it.
    void aborted.catch(() => {});
    const wait = promise => Promise.race([promise, aborted]);
    const finish = () => {
      stopped = true;
      active.delete(cancel);
      request.signal.removeEventListener("abort", onAbort);
    };
    const cancelNative = () => { void Promise.resolve(post("cancel")).catch(() => {}); };
    const cancel = (reason = abortError()) => {
      if (stopped) return;
      failure = reason;
      rejectAbort(reason);
      finish();
      void bodyReader?.cancel().catch(() => {});
      controller?.error(reason);
      cancelNative();
    };
    const onAbort = () => cancel(request.signal.reason || abortError());
    active.add(cancel);
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      let body = null;
      if (request.body) {
        bodyReader = request.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const next = await wait(bodyReader.read());
          if (failure) throw failure;
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maxBody) throw new TypeError("本机 MCP 原生连接的单次请求体不能超过 32 MiB。");
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
        body = encode(bytes);
        bodyReader.releaseLock();
        bodyReader = undefined;
      }
      if (failure) throw failure;
      const metadata = await wait(post("start", {
        url: endpoint.href, method: request.method, headers: Array.from(request.headers), body,
      }));
      if (failure) throw failure;
      const empty = request.method === "HEAD" || [204, 205, 304].includes(metadata.status);
      const stream = empty ? null : new ReadableStream({
        start(value) { controller = value; },
        async pull(value) {
          try {
            const chunk = await wait(post("read"));
            if (stopped) return;
            if (chunk.done) { finish(); value.close(); }
            else value.enqueue(decode(chunk.data));
          } catch (error) {
            if (!stopped) { finish(); value.error(error); cancelNative(); }
          }
        },
        cancel() { if (!stopped) { finish(); cancelNative(); } },
      }, { highWaterMark: 0 });
      const response = decorate(new Response(stream, {
        status: metadata.status, statusText: metadata.statusText || "", headers: metadata.headers,
      }), endpoint.href);
      if (empty) { finish(); cancelNative(); }
      return response;
    } catch (error) {
      if (!stopped) cancel(error);
      throw failure || error;
    }
  };
  window.addEventListener("pagehide", () => {
    for (const cancel of [...active]) cancel();
  });
  return true;
}
