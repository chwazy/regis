export type ConnectorState = 'starting' | 'connected' | 'error' | 'stopped';

export type ToolAccess = 'read' | 'write';

export interface ToolInfo {
  connectorId: string;
  name: string;
  qualifiedName: string;
  description?: string;
  inputSchema: unknown;
  access: ToolAccess;
  readOnlyHint?: boolean;
}

export interface ConnectorStatus {
  connectorId: string;
  state: ConnectorState;
  toolCount: number;
  error?: string;
  since: string;
}

export interface McpTestResult {
  ok: boolean;
  toolCount: number;
  error?: string;
  latencyMs: number;
}
