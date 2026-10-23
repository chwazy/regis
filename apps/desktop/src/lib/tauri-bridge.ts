import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core';
import { listen as tauriListen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';

export type { UnlistenFn };

const BRIDGE_PATH = '/__regis-bridge';

const useDevBridge = import.meta.env.DEV && !isTauri();

async function bridgeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${BRIDGE_PATH}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw `Pont de dev indisponible (${response.status}) : lancer l'app avec npm run dev`;
  }
  if (!response.ok) {
    throw body;
  }
  return body as T;
}

interface SharedStream {
  source: EventSource;
  handlers: Set<(payload: unknown) => void>;
}

const sharedStreams = new Map<string, SharedStream>();

import.meta.hot?.dispose(() => {
  for (const stream of sharedStreams.values()) {
    stream.source.close();
  }
  sharedStreams.clear();
});

function sharedStream(event: string): SharedStream {
  const existing = sharedStreams.get(event);
  if (existing) {
    return existing;
  }
  const stream: SharedStream = {
    source: new EventSource(`${BRIDGE_PATH}/events?event=${encodeURIComponent(event)}`),
    handlers: new Set(),
  };
  stream.source.onmessage = (message: MessageEvent<string>) => {
    const payload: unknown = JSON.parse(message.data);
    for (const handler of stream.handlers) {
      handler(payload);
    }
  };
  sharedStreams.set(event, stream);
  return stream;
}

function bridgeListen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const stream = sharedStream(event);
  let id = 0;
  const forward = (payload: unknown) => {
    id += 1;
    handler({ event, id, payload: payload as T });
  };
  stream.handlers.add(forward);
  return Promise.resolve(() => {
    stream.handlers.delete(forward);
    if (stream.handlers.size === 0) {
      stream.source.close();
      sharedStreams.delete(event);
    }
  });
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return useDevBridge ? bridgeInvoke<T>(cmd, args) : tauriInvoke<T>(cmd, args);
}

export function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return useDevBridge ? bridgeListen(event, handler) : tauriListen<T>(event, handler);
}
