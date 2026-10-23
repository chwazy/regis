import type { PingResult } from '@regis/shared';
import type { MethodHandler } from './rpc/server';
import packageJson from '../package.json';

export function createMethods(extra: Record<string, MethodHandler> = {}): Record<string, MethodHandler> {
  return {
    'system.ping': (): PingResult => ({
      name: 'regis-sidecar',
      version: packageJson.version,
      pid: process.pid,
    }),
    ...extra,
  };
}
