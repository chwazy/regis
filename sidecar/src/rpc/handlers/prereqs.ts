import type { PrereqReport } from '@regis/shared';
import { checkPrereqs, type PrereqDeps } from '../../prereqs/check';
import type { MethodHandler } from '../server';

export function createPrereqsMethods(deps: PrereqDeps): Record<string, MethodHandler> {
  return {
    'prereqs.check': (): Promise<PrereqReport> => checkPrereqs(deps),
  };
}
