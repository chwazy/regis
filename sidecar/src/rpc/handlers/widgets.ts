import { z } from 'zod';
import { RpcErrorCode, type ToolInfo } from '@regis/shared';
import { McpCallError } from '../../mcp/host';
import { classifyTool } from '../../mcp/classify';
import { RpcMethodError, type MethodHandler } from '../server';

export const MCP_TOOL_ALLOWLIST_SETTING = 'widgets.mcpToolAllowlist';

export interface WidgetsHandlerDeps {
  findTool: (connectorId: string, tool: string) => ToolInfo | undefined;
  callTool: (connectorId: string, tool: string, args: unknown) => Promise<unknown>;
  getSetting: (key: string) => Promise<string | null>;
}

const mcpToolParams = z.object({
  connectorId: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});

const allowlistSchema = z.array(z.string());

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
  }
  return parsed.data;
}

async function readAllowlist(getSetting: WidgetsHandlerDeps['getSetting']): Promise<string[]> {
  const raw = await getSetting(MCP_TOOL_ALLOWLIST_SETTING);
  if (raw === null) {
    return [];
  }
  try {
    return allowlistSchema.catch([]).parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

function looksWritable(info: ToolInfo): boolean {
  const heuristic = classifyTool({
    name: info.name,
    ...(info.readOnlyHint === undefined ? {} : { annotations: { readOnlyHint: info.readOnlyHint } }),
  });
  return info.access === 'write' || heuristic === 'write';
}

export function createWidgetsMethods(deps: WidgetsHandlerDeps): Record<string, MethodHandler> {
  return {
    'widgets.mcpTool': async (params) => {
      const { connectorId, tool, args } = parseParams(mcpToolParams, params);
      const info = deps.findTool(connectorId, tool);
      if (!info) {
        throw new RpcMethodError(RpcErrorCode.Unavailable, `Outil indisponible : ${tool}`, {
          connectorId,
          tool,
        });
      }
      if (looksWritable(info)) {
        throw new RpcMethodError(RpcErrorCode.PolicyDenied, `Outil d’écriture refusé : ${tool}`, {
          connectorId,
          tool,
        });
      }
      const allowlisted = (await readAllowlist(deps.getSetting)).includes(info.qualifiedName);
      if (info.readOnlyHint !== true && !allowlisted) {
        throw new RpcMethodError(
          RpcErrorCode.PolicyDenied,
          `Outil sans indication de lecture seule explicite : ${tool}`,
          { connectorId, tool },
        );
      }
      try {
        return await deps.callTool(connectorId, tool, args ?? {});
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
