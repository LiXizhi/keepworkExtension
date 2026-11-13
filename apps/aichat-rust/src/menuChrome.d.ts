export function mountDesktopMenus(options: {
  host: HTMLElement;
  shadow: ShadowRoot;
  left: HTMLElement;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  menus: Array<{ id: string; label: string }>;
  nativeMenu?: boolean;
}): { close(): void };
