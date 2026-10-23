import { z } from 'zod';
import { RpcErrorCode, type Connector, type ConnectorStatus } from '@regis/shared';
import { McpCallError, type McpHost } from '../../mcp/host';
import { RpcMethodError, type MethodHandler } from '../server';

export interface HostStore {
  listConnectors: () => Promise<Connector[]>;
}

const connectorIdParams = z.object({ connectorId: z.string().min(1) });
const listToolsParams = z.object({ connectorId: z.string().min(1).optional() });
const callToolParams = z.object({
  connectorId: z.string().min(1),
  tool: z.string().min(1),
  args: z.unknown().optional(),
});

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
  }
  return parsed.data;
}

export function createMcpMethods(host: McpHost, store: HostStore): Record<string, MethodHandler> {
  const requireConnector = async (connectorId: string): Promise<Connector> => {
    const connector = (await store.listConnectors()).find((candidate) => candidate.id === connectorId);
    if (!connector) {
      throw new RpcMethodError(RpcErrorCode.InvalidParams, `Unknown connector: ${connectorId}`);
    }
    return connector;
  };

  return {
    'mcp.start': async (params) => {
      const { connectorId } = parseParams(connectorIdParams, params);
      return host.start(await requireConnector(connectorId));
    },
    'mcp.stop': async (params) => {
      const { connectorId } = parseParams(connectorIdParams, params);
      await host.stop(connectorId);
      return {};
    },
    'mcp.status': async (): Promise<ConnectorStatus[]> => {
      const connectors = await store.listConnectors();
      return connectors.map((connector) => host.status(connector.id));
    },
    'mcp.listTools': (params) => {
      const { connectorId } = parseParams(listToolsParams, params);
      return host.listTools(connectorId);
    },
    'mcp.test': async (params) => {
      const { connectorId } = parseParams(connectorIdParams, params);
      return host.test(await requireConnector(connectorId));
    },
    'mcp.callTool': async (params) => {
      const { connectorId, tool, args } = parseParams(callToolParams, params);
      try {
        return await host.callTool(connectorId, tool, args);
      } catch (error) {
        if (error instanceof McpCallError) {
          throw new RpcMethodError(RpcErrorCode.Unavailable, error.message, {
            connectorId: error.connectorId,
            tool: error.tool,
          });
        }
        throw error;
      }
    },
  };
}

export async function startEnabledConnectors(
  host: McpHost,
  store: HostStore,
  onLog: (line: string) => void,
): Promise<void> {
  const connectors = await store.listConnectors();
  const startable = connectors.filter((connector) => connector.enabled && connector.transport !== 'builtin');
  await Promise.all(
    startable.map((connector) =>
      host.start(connector).catch((error: unknown) => {
        onLog(`[mcp:${connector.name}] start failed: ${String(error)}`);
      }),
    ),
  );
}
