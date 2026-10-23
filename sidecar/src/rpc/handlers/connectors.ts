import { z } from 'zod';
import { RpcErrorCode } from '@regis/shared';
import { buildFromPreset } from '../../connectors/presets';
import { RpcMethodError, type MethodHandler } from '../server';

const buildParams = z.object({
  presetId: z.string().min(1),
  options: z
    .object({
      name: z.string().optional(),
      tenantId: z.string().optional(),
      clientId: z.string().optional(),
      url: z.string().optional(),
      db: z.string().optional(),
      login: z.string().optional(),
    })
    .optional(),
});

export function createConnectorMethods(): Record<string, MethodHandler> {
  return {
    'connectors.presets.build': (params) => {
      const parsed = buildParams.safeParse(params ?? {});
      if (!parsed.success) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
      }
      try {
        return buildFromPreset(parsed.data.presetId, parsed.data.options);
      } catch (error) {
        throw new RpcMethodError(
          RpcErrorCode.InvalidParams,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
