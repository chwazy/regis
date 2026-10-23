import { z } from 'zod';
import type { ToolDecision } from '../agents/driver';

export const approveInputShape = {
  tool_name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().optional(),
};

const approveArguments = z.object(approveInputShape);

export type PermissionResponse =
  { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string };

export interface ApproveContext {
  jobId: string;
  agentId: string;
}

export interface ApproveDeps {
  authorize: (context: ApproveContext, toolName: string, input: unknown) => Promise<ToolDecision>;
}

export function createApprove(deps: ApproveDeps) {
  return async (context: ApproveContext, args: unknown): Promise<PermissionResponse> => {
    const parsed = approveArguments.safeParse(args);
    if (!parsed.success) {
      return { behavior: 'deny', message: `Requête de permission invalide : ${parsed.error.message}` };
    }
    let decision: ToolDecision;
    try {
      decision = await deps.authorize(context, parsed.data.tool_name, parsed.data.input);
    } catch (error) {
      return {
        behavior: 'deny',
        message: `Validation impossible : ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!decision.allow) {
      return { behavior: 'deny', message: decision.message };
    }
    return decision.updatedInput === undefined
      ? { behavior: 'allow' }
      : { behavior: 'allow', updatedInput: decision.updatedInput };
  };
}

export function permissionResult(response: PermissionResponse): {
  content: { type: 'text'; text: string }[];
} {
  return { content: [{ type: 'text', text: JSON.stringify(response) }] };
}
