import { z } from 'zod';
import { RpcErrorCode } from '@regis/shared';
import { McpCallError } from '../../mcp/host';
import type { SyncEngine } from '../../sync/engine';
import { M365LoginError, type M365Login } from '../../sync/m365-login';
import { RpcMethodError, type MethodHandler } from '../server';

const connectorIdParams = z.object({ connectorId: z.string().min(1) });
const beginLoginParams = connectorIdParams.extend({ force: z.boolean().optional() });

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
  }
  return parsed.data;
}

async function unavailableOnFailure<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof McpCallError || error instanceof M365LoginError) {
      throw new RpcMethodError(RpcErrorCode.Unavailable, error.message);
    }
    if (error instanceof Error && error.message.startsWith('Unknown connector')) {
      throw new RpcMethodError(RpcErrorCode.InvalidParams, error.message);
    }
    throw error;
  }
}

export function createSyncMethods(engine: SyncEngine, login: M365Login): Record<string, MethodHandler> {
  return {
    'sync.run': (params) => {
      const { connectorId } = parseParams(connectorIdParams, params);
      return unavailableOnFailure(() => engine.runNow(connectorId));
    },
    'connectors.m365.beginLogin': (params) => {
      const { connectorId, force } = parseParams(beginLoginParams, params);
      return unavailableOnFailure(() => login.begin(connectorId, force));
    },
    'connectors.m365.loginStatus': (params) => {
      const { connectorId } = parseParams(connectorIdParams, params);
      return unavailableOnFailure(() => login.status(connectorId));
    },
  };
}
