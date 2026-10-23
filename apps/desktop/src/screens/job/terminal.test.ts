import { describe, expect, it } from 'vitest';
import { bindTerminalIo, decodeBase64, terminalTheme, type TerminalIo } from './terminal';

function fakeTerminal() {
  const listeners: {
    data?: (data: string) => void;
    resize?: (size: { cols: number; rows: number }) => void;
  } = {};
  const terminal: TerminalIo = {
    onData: (listener) => {
      listeners.data = listener;
      return { dispose: () => (listeners.data = undefined) };
    },
    onResize: (listener) => {
      listeners.resize = listener;
      return { dispose: () => (listeners.resize = undefined) };
    },
  };
  return { terminal, listeners };
}

describe('terminal bridge', () => {
  it('forwards keystrokes to pty_write', () => {
    const { terminal, listeners } = fakeTerminal();
    const calls: [string, Record<string, unknown>][] = [];
    bindTerminalIo(
      terminal,
      'J1',
      (command, args) => (calls.push([command, args]), Promise.resolve()),
      () => true,
    );

    listeners.data?.('ls\r');

    expect(calls).toEqual([['pty_write', { id: 'J1', data: 'ls\r' }]]);
  });

  it('calls pty_resize with the new columns and rows when the panel is resized', () => {
    const { terminal, listeners } = fakeTerminal();
    const calls: [string, Record<string, unknown>][] = [];
    bindTerminalIo(
      terminal,
      'J1',
      (command, args) => (calls.push([command, args]), Promise.resolve()),
      () => true,
    );

    listeners.resize?.({ cols: 132, rows: 41 });

    expect(calls).toEqual([['pty_resize', { id: 'J1', cols: 132, rows: 41 }]]);
  });

  it('sends nothing while the process is not running and after disposal', () => {
    const { terminal, listeners } = fakeTerminal();
    const calls: string[] = [];
    let live = false;
    const binding = bindTerminalIo(
      terminal,
      'J1',
      (command) => (calls.push(command), Promise.resolve()),
      () => live,
    );

    listeners.data?.('x');
    live = true;
    binding.dispose();

    expect(calls).toEqual([]);
    expect(listeners.data).toBeUndefined();
    expect(listeners.resize).toBeUndefined();
  });

  it('decodes base64 output as raw bytes, keeping split UTF-8 sequences intact', () => {
    const bytes = decodeBase64(btoa(String.fromCharCode(0xc3, 0xa9, 0x1b)));

    expect([...bytes]).toEqual([0xc3, 0xa9, 0x1b]);
  });

  it('builds the xterm theme from the design tokens', () => {
    const values: Record<string, string> = { '--surface': ' #ffffff ', '--text': '#101828' };
    const theme = terminalTheme({ getPropertyValue: (name) => values[name] ?? '' });

    expect(theme.background).toBe('#ffffff');
    expect(theme.foreground).toBe('#101828');
  });
});
