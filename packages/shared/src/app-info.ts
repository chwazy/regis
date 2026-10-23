import type { PingResult } from './rpc';

export interface AppInfo {
  version: string;
  dataDir: string;
  schemaVersion: number;
  vecVersion: string;
  sidecar: PingResult | null;
}
