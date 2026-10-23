import { z } from 'zod';
import { RpcErrorCode } from '@regis/shared';
import { NoEligibleAgentError, TASK_TYPES, type RoutingDecision } from '../../routing/engine';
import type { DecideRoute } from '../../routing/service';
import { RpcMethodError, type MethodHandler } from '../server';

const previewParams = z.object({
  task: z.string().min(1),
  taskType: z.enum(TASK_TYPES).optional(),
  clientId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

export function createRoutingMethods(decide: DecideRoute): Record<string, MethodHandler> {
  return {
    'routing.preview': async (params): Promise<RoutingDecision> => {
      const parsed = previewParams.safeParse(params ?? {});
      if (!parsed.success) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
      }
      try {
        return await decide({ ...parsed.data, source: 'task' });
      } catch (error) {
        if (error instanceof NoEligibleAgentError) {
          throw new RpcMethodError(RpcErrorCode.Unavailable, error.message);
        }
        throw error;
      }
    },
  };
}
