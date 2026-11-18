// Decode untrusted artwork in Chromium, then send only a bounded PNG frame to
// GDI+ (older Windows cannot decode the WebP sheets used by AIChat).
window.__keepworkCreatePetArtwork = publish => {
  let current = null, disposed = false;
  const maxPng = 128 * 1024;
  function sourceOf(pet) {
    const data = pet?.imageData;
    if (typeof data === 'string' && data.length <= 8 * 1024 * 1024 + 64
        && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) return data;
    try {
      const url = new URL(pet?.sheetUrl);
      if (url.protocol === 'https:' && url.hostname === 'cdn.keepwork.com'
          && !url.username && !url.password && !url.port && !url.search && !url.hash) return url.href;
    } catch { /* Missing artwork is an ordinary legacy state. */ }
    return '';
  }
  function percent(raw, fallback, min, max) {
    const match = typeof raw === 'string' && raw.length <= 64
      && /^(\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(raw);
    if (!match) return fallback;
    const pair = [Number(match[1]), Number(match[2])];
    return pair.every(n => Number.isFinite(n) && n >= min && n <= max) ? pair : fallback;
  }
  function cancel(entry) {
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.controller?.abort();
    if (entry.image) { entry.image.onload = entry.image.onerror = null; entry.image.src = ''; }
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    entry.image = null; entry.objectUrl = '';
  }
  function send(entry, png = '') {
    if (!disposed && current === entry) publish({ context: entry.context, name: entry.name, png });
  }
  async function load(entry) {
    try {
      let source = entry.source;
      if (!source.startsWith('data:')) {
        entry.controller = new AbortController();
        const response = await fetch(source, { credentials: 'omit', redirect: 'error',
          referrerPolicy: 'no-referrer', signal: entry.controller.signal });
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (!response.ok || !/^image\/(png|jpeg|webp|gif)$/.test(type || '')
            || Number(response.headers.get('content-length')) > 6 * 1024 * 1024) throw Error('Unsupported artwork');
        const reader = response.body.getReader(), chunks = [];
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 6 * 1024 * 1024 || disposed || current !== entry) {
            await reader.cancel(); throw Error('Artwork unavailable');
          }
          chunks.push(value);
        }
        if (disposed || current !== entry) return;
        source = entry.objectUrl = URL.createObjectURL(new Blob(chunks, { type }));
      }
      if (disposed || current !== entry) return;
      const image = entry.image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve; image.onerror = reject; image.src = source;
      });
      if (disposed || current !== entry) return;
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!width || !height || width > 4096 || height > 4096) throw Error('Unsupported dimensions');
      // CSS background-position percentages measure the remaining space, not
      // the entire sheet: 100% on a 4x4 sheet selects its final column/row.
      const w = width * 100 / entry.size[0], h = height * 100 / entry.size[1];
      const x = (width - w) * entry.position[0] / 100, y = (height - h) * entry.position[1] / 100;
      const canvas = document.createElement('canvas');
      let png = '';
      for (const pixels of [256, 128]) {
        canvas.width = canvas.height = pixels;
        const context = canvas.getContext('2d');
        context.drawImage(image, x, y, w, h, 0, 0, pixels, pixels);
        png = canvas.toDataURL('image/png');
        if (png.startsWith('data:image/png;base64,') && png.length <= maxPng) break;
      }
      if (!png.startsWith('data:image/png;base64,') || png.length > maxPng) throw Error('Artwork too large');
      entry.complete = true;
      send(entry, png);
    } catch {
      if (current === entry) { entry.failed = Date.now(); send(entry); }
    } finally { cancel(entry); }
  }
  return {
    update(pet, context) {
      if (disposed) return;
      const source = sourceOf(pet);
      const name = typeof pet?.name === 'string' ? pet.name.trim().slice(0, 48) : '';
      const size = percent(pet?.bgSize, [400, 400], 100, 1600);
      const position = percent(pet?.bgPos, [0, 0], 0, 100);
      if (current && current.context === context && current.source === source && current.name === name
          && String(current.size) === String(size) && String(current.position) === String(position)
          && (!current.failed || Date.now() - current.failed < 15000)) return;
      cancel(current);
      const entry = current = { context, source, name, size, position };
      send(entry);
      if (!source) return;
      entry.timer = setTimeout(() => {
        if (current !== entry || entry.complete) return;
        cancel(entry); entry.failed = Date.now(); send(entry);
        current = null;
      }, 15000);
      void load(entry);
    },
    dispose() { disposed = true; cancel(current); current = null; },
  };
};
