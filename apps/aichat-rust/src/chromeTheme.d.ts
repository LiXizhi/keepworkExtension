export function mountDesktopTheme(options: {
  host: HTMLElement;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}): void;
