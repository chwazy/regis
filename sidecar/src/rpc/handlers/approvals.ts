import { z } from 'zod';
import { RpcErrorCode, type ToolAccess } from '@regis/shared';
import type { ApprovalDecision } from '../../approvals/service';
import type { PolicyMatch } from '../../policy/resolve';
import { RpcMethodError, type MethodHandler } from '../server';

export interface ApprovalsHandlerDeps {
  approvals: { resolve: (approvalId: string, decision: ApprovalDecision) => Promise<void> };
  policy: { resolve: (agentId: string, tool: string, access: ToolAccess) => Promise<PolicyMatch> };
  findToolAccess: (qualifiedName: string) => ToolAccess | undefined;
}

const resolveParams = z.object({
  approvalId: z.string().min(1),
  decision: z.object({
    status: z.enum(['approved', 'edited', 'rejected']),
    updatedInput: z.unknown().optional(),
    note: z.string().optional(),
  }),
});
const policyParams = z.object({ agentId: z.string().min(1), tool: z.string().min(1) });

export function createApprovalsMethods(deps: ApprovalsHandlerDeps): Record<string, MethodHandler> {
  return {
    'approvals.resolve': async (params) => {
      const parsed = resolveParams.safeParse(params ?? {});
      if (!parsed.success) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
      }
      const { status, updatedInput, note } = parsed.data.decision;
      try {
        await deps.approvals.resolve(parsed.data.approvalId, {
          status,
          ...(updatedInput === undefined ? {} : { updatedInput }),
          ...(note === undefined ? {} : { note }),
        });
      } catch (error) {
        throw new RpcMethodError(
          RpcErrorCode.InvalidParams,
          error instanceof Error ? error.message : String(error),
        );
      }
      return {};
    },
    'policy.resolve': async (params): Promise<PolicyMatch> => {
      const parsed = policyParams.safeParse(params ?? {});
      if (!parsed.success) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
      }
      const access = deps.findToolAccess(parsed.data.tool) ?? 'write';
      return deps.policy.resolve(parsed.data.agentId, parsed.data.tool, access);
    },
  };
}
