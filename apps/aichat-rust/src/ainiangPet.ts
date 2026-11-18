/// <reference types="vite/client" />
const manifests = import.meta.glob('../assets/ainiang/*/manifest.json', { eager: true, import: 'default' }) as Record<string, Manifest>;
const images = import.meta.glob('../assets/ainiang/*/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export const ainiangIds = ['claude', 'gpt', 'gemini', 'grok', 'qwen', 'kimi', 'glm', 'minimax', 'deepseek'] as const;
type Pose = 'idle' | 'happy' | 'listening' | 'thinking' | 'speaking' | 'sleeping' | 'error';
interface Manifest { width: number; height: number; poster: { path: string }; poses: Record<Pose, { file: { path: string }; frameCount: number; frameDurationMs: number; columns?: number }> }
interface Snapshot { effectiveAppearance?: string; preferences?: { appearance?: string }; error?: string; phoneError?: string; dictating?: boolean; busy?: boolean; phoneState?: string; remoteDialogue?: { state?: string } | null; voice?: { active?: boolean; state?: string; muted?: boolean }; petSpeech?: { state?: string } | null; reply?: { thinking?: boolean } | null }
export function ainiangId(appearance?: string): string | undefined { return ainiangIds.find(id => appearance === `ainiang:${id}`); }
const appearanceNames: Record<string, string> = {
  claude: '圣女果 · Claude', gpt: '小龙女 · GPT', gemini: '哈基米 · Gemini',
  grok: '大小姐 · Grok', qwen: '千金金 · Qwen', kimi: '小狐狸 · Kimi',
  glm: '嘎拉吗 · GLM', minimax: '小田螺 · MiniMax', deepseek: '大肥鱼 · DeepSeek',
};
export function ainiangAppearanceName(appearance?: string): string | undefined {
  const id = ainiangId(appearance);
  return id ? `${appearanceNames[id]}（实验外观）` : undefined;
}
export function ainiangPose(state: Snapshot): Pose {
  if (state.error || state.phoneError) return 'error';
  const phase = state.phoneState || state.remoteDialogue?.state || (state.voice?.active ? state.voice.state : '');
  if (phase === 'speaking' || state.petSpeech?.state === 'speaking') return 'speaking';
  if (phase === 'thinking' || phase === 'tool' || state.busy || state.reply?.thinking) return 'thinking';
  if (state.dictating || (phase === 'listening' && !state.voice?.muted)) return 'listening';
  return 'idle';
}
export function ainiangFrame(elapsed: number, count: number, duration: number): number { return Math.floor(Math.max(0, elapsed) / duration) % count; }
export interface PetAlphaMask { width: number; height: number; bits: string }
interface BodyBounds { left: number; top: number; width: number; height: number }
interface HitShape { mask: PetAlphaMask; bounds: BodyBounds }
export function maskContains(mask: PetAlphaMask, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= 1 || y >= 1) return false;
  const bit = Math.floor(y * mask.height) * mask.width + Math.floor(x * mask.width);
  return (parseInt(mask.bits[Math.floor(bit / 4)] || '0', 16) & (8 >> (bit % 4))) !== 0;
}

// Decode only bundled, already-verified images. A bounded mask keeps transparent
// pixels out of native hit testing without changing artwork size or quality.
function decodeShapes(image: HTMLImageElement, width: number, height: number, columns: number, count: number): Array<HitShape | null> {
  try {
    const size = Math.min(256, Math.max(width, height));
    if (!Number.isInteger(size) || size < 1) return [];
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    const scale = size / Math.max(width, height), w = width * scale, h = height * scale;
    return Array.from({ length: count }, (_, frame) => {
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(image, (frame % columns) * width, Math.floor(frame / columns) * height, width, height,
        (size - w) / 2, (size - h) / 2, w, h);
      const data = ctx.getImageData(0, 0, size, size).data;
      const bytes = new Uint8Array(Math.ceil(size * size / 8));
      let left = size, top = size, right = 0, bottom = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const bit = y * size + x;
        if (data[bit * 4 + 3] < 16) continue;
        bytes[bit >> 3] |= 128 >> (bit % 8);
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
      }
      if (right <= left || bottom <= top) return null;
      return { mask: { width: size, height: size, bits: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') },
        bounds: { left: left / size, top: top / size, width: (right - left) / size, height: (bottom - top) / size } };
    });
  } catch { return []; } // No decoded alpha means no body hit target, never a full-square fallback.
}

export function createAiniangRenderer(art: HTMLElement, setStyle: (key: 'backgroundImage' | 'backgroundSize' | 'backgroundPosition' | 'clipPath', value: string) => void, onShapeChanged?: () => void) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let timer = 0, generation = 0;
  let key = '', disposed = false;
  let nativeHidden = (window as Window & { __aichatPetHidden?: boolean }).__aichatPetHidden === true;
  let current: Snapshot = {};
  let shape: HitShape | null = null, anchor: BodyBounds | undefined, anchorId = '';
  let posterBounds: BodyBounds | undefined, crop: BodyBounds | undefined;
  const unionBounds = (bounds: Array<BodyBounds | undefined>): BodyBounds | undefined => {
    const visible = bounds.filter((value): value is BodyBounds => !!value);
    if (!visible.length) return undefined;
    const left = Math.min(...visible.map(value => value.left));
    const top = Math.min(...visible.map(value => value.top));
    return { left, top,
      width: Math.max(...visible.map(value => value.left + value.width)) - left,
      height: Math.max(...visible.map(value => value.top + value.height)) - top };
  };
  const shapes = new Map<string, Array<HitShape | null>>();
  const decoded = (url: string, image: HTMLImageElement, width: number, height: number, columns: number, count: number) => {
    const cached = shapes.get(url);
    if (cached) return cached;
    const result = decodeShapes(image, width, height, columns, count);
    if (shapes.size >= 8) shapes.delete(shapes.keys().next().value!);
    shapes.set(url, result);
    return result;
  };
  const publish = (value: HitShape | null) => { shape = value; if (!anchor && value) anchor = value.bounds; onShapeChanged?.(); };
  const stop = () => { window.clearTimeout(timer); timer = 0; generation++; };
  // Paths resolve exclusively through the bundled registry, never snapshot URLs.
  const asset = (id: string, path: string) => /^[a-z]+\.png$/.test(path) ? images[`../assets/ainiang/${id}/${path}`] : undefined;
  function update(state: Snapshot): boolean {
    current = state;
    const id = ainiangId(state.effectiveAppearance ?? state.preferences?.appearance);
    const manifest = id && manifests[`../assets/ainiang/${id}/manifest.json`];
    if (!id || !manifest || disposed) { stop(); key = ''; anchor = undefined; anchorId = ''; posterBounds = crop = undefined; publish(null); art.classList.remove('ainiang-art'); setStyle('clipPath', ''); return false; }
    const pose = ainiangPose(state);
    const next = `${id}:${pose}:${document.hidden || nativeHidden}:${motion.matches}`;
    if (next === key) return true;
    stop(); key = next; art.classList.add('ainiang-art');
    if (anchorId !== id) { anchorId = id; anchor = undefined; posterBounds = undefined; }
    crop = posterBounds;
    publish(null);
    const poster = asset(id, manifest.poster.path);
    setStyle('backgroundImage', poster ? `url(${JSON.stringify(poster)})` : '');
    setStyle('clipPath', ''); setStyle('backgroundSize', 'contain'); setStyle('backgroundPosition', 'center');
    if (document.hidden || nativeHidden) return true;
    const ticket = generation;
    let animated = false;
    if (onShapeChanged && poster) {
      const preview = new Image();
      preview.onload = () => {
        if (ticket !== generation || disposed) return;
        const body = decoded(poster, preview, manifest.width, manifest.height, 1, 1)[0] || null;
        anchor = posterBounds = body?.bounds;
        crop = unionBounds([crop, posterBounds]);
        if (!animated) publish(body); else onShapeChanged();
      };
      preview.src = poster;
    }
    if (motion.matches) return true;
    const strip = manifest.poses[pose];
    const url = strip && asset(id, strip.file.path);
    if (!url || !Number.isInteger(strip.frameCount) || strip.frameCount < 1 || !Number.isFinite(strip.frameDurationMs) || strip.frameDurationMs < 16) return true;
    const columns = strip.columns ?? strip.frameCount;
    if (!Number.isInteger(columns) || columns < 1 || columns > strip.frameCount) return true;
    const rows = Math.ceil(strip.frameCount / columns);
    const width = manifest.width || 1, height = manifest.height || 1;
    const frameWidth = Math.min(1, width / height), frameHeight = Math.min(1, height / width);
    const position = (index: number, count: number, size: number) => {
      const span = 1 - count * size;
      const offset = (1 - size) / 2 - index * size;
      return span === 0 && offset !== 0
        ? `calc(var(--pet-pixels, 112px) * ${offset})`
        : `${span === 0 ? 0 : Number((offset / span * 100).toFixed(10))}%`;
    };
    const preload = new Image();
    preload.onload = () => {
      if (ticket !== generation || disposed) return;
      const frames = onShapeChanged ? decoded(url, preload, width, height, columns, strip.frameCount) : [];
      crop = unionBounds([posterBounds, ...frames.map(frame => frame?.bounds)]);
      animated = true;
      const started = performance.now();
      const tick = () => {
        if (ticket !== generation || disposed) return;
        const frame = ainiangFrame(performance.now() - started, strip.frameCount, strip.frameDurationMs);
        setStyle('backgroundImage', `url(${JSON.stringify(url)})`);
        setStyle('backgroundSize', `${columns * frameWidth * 100}% ${rows * frameHeight * 100}%`);
        // Clip adjacent atlas rows/columns while preserving the original square-padded footprint.
        setStyle('clipPath', `inset(${(1 - frameHeight) * 50}% ${(1 - frameWidth) * 50}%)`);
        setStyle('backgroundPosition', `${position(frame % columns, columns, frameWidth)} ${position(Math.floor(frame / columns), rows, frameHeight)}`);
        if (onShapeChanged) publish(frames[frame] || null);
        timer = window.setTimeout(tick, strip.frameDurationMs);
      };
      tick();
    };
    preload.src = url;
    return true;
  }
  const refresh = () => update(current);
  const hide = () => { nativeHidden = true; refresh(); };
  const show = () => { nativeHidden = false; refresh(); };
  const dispose = () => { disposed = true; stop(); shape = null; crop = posterBounds = undefined; shapes.clear(); window.removeEventListener('aichat:pet-hidden', hide); window.removeEventListener('aichat:pet-shown', show); document.removeEventListener('visibilitychange', refresh); motion.removeEventListener('change', refresh); window.removeEventListener('pagehide', dispose); };
  window.addEventListener('aichat:pet-hidden', hide); window.addEventListener('aichat:pet-shown', show);
  document.addEventListener('visibilitychange', refresh); motion.addEventListener('change', refresh); window.addEventListener('pagehide', dispose);
  return { update, dispose, bodyBounds: () => anchor, cropBounds: () => crop, hitShape: (): HitShape | null => shape && { mask: shape.mask, bounds: anchor || shape.bounds } };
}
