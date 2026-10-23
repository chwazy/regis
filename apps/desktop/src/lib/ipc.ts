import { REGIS_EVENT_CHANNEL, type RegisEvent, type RegisTopic } from '@regis/shared';
import { invoke, listen } from './tauri-bridge';

export function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

export function sidecarCall<T>(method: string, params?: unknown, timeoutSecs?: number): Promise<T> {
  return invokeCmd<T>('sidecar_call', {
    method,
    params: params ?? null,
    ...(timeoutSecs === undefined ? {} : { timeoutSecs }),
  });
}

export function onRegisEvent<T>(topic: RegisTopic, cb: (e: RegisEvent<T>) => void): Promise<() => void> {
  return listen<RegisEvent<T>>(REGIS_EVENT_CHANNEL, (event) => {
    if (event.payload.topic === topic) {
      cb(event.payload);
    }
  });
}
