interface Disposable {
  dispose: () => void;
}

export interface TerminalIo {
  onData: (listener: (data: string) => void) => Disposable;
  onResize: (listener: (size: { cols: number; rows: number }) => void) => Disposable;
}

export type CommandCaller = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bindTerminalIo(
  terminal: TerminalIo,
  id: string,
  call: CommandCaller,
  isLive: () => boolean,
): Disposable {
  const ignore = () => undefined;
  const input = terminal.onData((data) => {
    if (isLive()) {
      call('pty_write', { id, data }).catch(ignore);
    }
  });
  const size = terminal.onResize(({ cols, rows }) => {
    if (isLive()) {
      call('pty_resize', { id, cols, rows }).catch(ignore);
    }
  });
  return {
    dispose: () => {
      input.dispose();
      size.dispose();
    },
  };
}

export function terminalTheme(styles: Pick<CSSStyleDeclaration, 'getPropertyValue'>): Record<string, string> {
  const read = (name: string): string => styles.getPropertyValue(name).trim();
  return {
    background: read('--surface'),
    foreground: read('--text'),
    cursor: read('--accent'),
    cursorAccent: read('--surface'),
    selectionBackground: read('--accent-soft'),
    selectionForeground: read('--text'),
  };
}
