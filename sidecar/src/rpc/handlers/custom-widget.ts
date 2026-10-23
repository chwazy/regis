import { z } from 'zod';
import { RpcErrorCode, type CustomWidgetSpec } from '@regis/shared';
import { NoEligibleAgentError } from '../../routing/engine';
import { CustomWidgetFormatError } from '../../widgets/custom-generate';
import { RpcMethodError, type MethodHandler } from '../server';

export interface CustomWidgetHandlerDeps {
  generate: (description: string) => Promise<CustomWidgetSpec>;
}

const generateParams = z.object({ description: z.string().trim().min(1).max(500) });

export function createCustomWidgetMethods(deps: CustomWidgetHandlerDeps): Record<string, MethodHandler> {
  return {
    'widgets.generateCustom': async (params) => {
      const parsed = generateParams.safeParse(params ?? {});
      if (!parsed.success) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
      }
      try {
        return { spec: await deps.generate(parsed.data.description) };
      } catch (error) {
        if (error instanceof NoEligibleAgentError) {
          throw new RpcMethodError(RpcErrorCode.Unavailable, error.message);
        }
        if (error instanceof CustomWidgetFormatError) {
          throw new RpcMethodError(RpcErrorCode.InvalidParams, error.message);
        }
        throw error;
      }
    },
  };
}
