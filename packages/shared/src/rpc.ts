export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}
export interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: RpcError;
}
export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}
export const RpcErrorCode = {
  ParseError: -32700,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  PolicyDenied: 1001,
  NotConfigured: 1002,
  Unavailable: 1003,
} as const;
export interface PingResult {
  name: 'regis-sidecar';
  version: string;
  pid: number;
}

export interface MinutesGenerateParams {
  transcriptItemId: string;
}
export interface MinutesExportParams {
  minutesItemId: string;
  templateId: string;
}
export interface MinutesExportResult {
  fileIds: string[];
}

export type PrereqId = 'ollama' | 'claudeCli' | 'wordPdf';
export type PrereqState = 'ok' | 'missing' | 'unreachable';
export interface PrereqItem {
  id: PrereqId;
  label: string;
  required: boolean;
  state: PrereqState;
  detail: string;
  help: string | null;
}
export interface PrereqReport {
  items: PrereqItem[];
  ollamaModels: string[];
  checkedAt: string;
}
