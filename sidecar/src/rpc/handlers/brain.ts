import { z } from 'zod';
import { RpcErrorCode } from '@regis/shared';
import type { EntitySuggestion } from '../../brain/suggest-link';
import { RpcMethodError, type MethodHandler } from '../server';

export interface BrainHandlerDeps {
  requestRun: () => void;
  refreshSynthesis: (entityId: string) => Promise<unknown>;
  suggestEntityForFile: (fileId: string, k?: number) => Promise<EntitySuggestion[]>;
}

const synthesizeParams = z.object({ entityId: z.string().min(1) });

const suggestParams = z.object({
  fileId: z.string().min(1),
  k: z.number().int().positive().optional(),
});

export function createBrainMethods(deps: BrainHandlerDeps): Record<string, MethodHandler> {
  return {
    'brain.run': () => {
      deps.requestRun();
      return { started: true };
    },
    'brain.synthesize': (params) => {
      const parsed = synthesizeParams.safeParse(params ?? {});
      if (!parsed.success) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
      }
      void deps.refreshSynthesis(parsed.data.entityId).catch(() => undefined);
      return { started: true };
    },
    'brain.suggestEntity': async (params): Promise<EntitySuggestion[]> => {
      const parsed = suggestParams.safeParse(params ?? {});
      if (!parsed.success) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
      }
      return deps.suggestEntityForFile(parsed.data.fileId, parsed.data.k);
    },
  };
}
