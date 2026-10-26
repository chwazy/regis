import type { Agent, ToolAccess, ToolInfo } from '@regis/shared';
import { BUILT_IN_WRITE_TOOLS } from '../agents/deny-writes-policy';
import type { AgentToolPolicy, ToolDecision, ToolFlags } from '../agents/driver';
import { hasAnswers, isUserQuestion } from '../approvals/questions';
import { DEFERRED_DENY_MESSAGE, type ApprovalDecision } from '../approvals/service';
import { REGIS_BRAIN_READ_TOOLS, REGIS_BRAIN_WRITE_TOOLS } from '../regis-mcp/brain-tools';
import { REGIS_JOB_TOOLS } from '../regis-mcp/jobs-tools';
import { REGIS_RENDER_TEMPLATE_TOOL } from '../regis-mcp/template-tools';
import { buildToolFlags } from './flags';
import {
  resolvePolicyMatch,
  type DefaultWrite,
  type Policy,
  type PolicyMatch,
  type PolicyRule,
} from './resolve';

export const REGIS_PERMISSION_TOOL = 'mcp__regis__approve';

export interface ToolAuthorization {
  agentId: string;
  jobId: string;
  qualifiedName: string;
  access: ToolAccess;
  input: unknown;
}

export interface ToolPolicyDeps {
  listRules: () => Promise<PolicyRule[]>;
  getDefaultWrite?: () => Promise<DefaultWrite>;
  approvals: {
    request: (jobId: string, tool: string, input: unknown) => Promise<ApprovalDecision | 'deferred'>;
  };
}

export interface RegisToolPolicy extends AgentToolPolicy {
  authorize: (request: ToolAuthorization) => Promise<ToolDecision>;
  resolve: (agentId: string, qualifiedName: string, access: ToolAccess) => Promise<PolicyMatch>;
}

export function forbiddenMessage(qualifiedName: string): string {
  return `Outil interdit par la politique : ${qualifiedName}`;
}

export function createToolPolicy(deps: ToolPolicyDeps): RegisToolPolicy {
  const readDefaultWrite = async (): Promise<DefaultWrite> => (await deps.getDefaultWrite?.()) ?? 'ask';
  const resolve = async (agentId: string, qualifiedName: string, access: ToolAccess): Promise<PolicyMatch> =>
    resolvePolicyMatch(await deps.listRules(), agentId, qualifiedName, access, await readDefaultWrite());

  const authorize = async (request: ToolAuthorization): Promise<ToolDecision> => {
    const { policy } = await resolve(request.agentId, request.qualifiedName, request.access);
    const question = isUserQuestion(request.qualifiedName);
    if (policy === 'auto' && !question) {
      return { allow: true };
    }
    if (policy === 'deny') {
      return { allow: false, message: forbiddenMessage(request.qualifiedName) };
    }
    const decision = await deps.approvals.request(request.jobId, request.qualifiedName, request.input);
    if (decision === 'deferred') {
      return { allow: false, message: DEFERRED_DENY_MESSAGE };
    }
    if (decision.status === 'rejected') {
      return { allow: false, message: decision.note?.trim() || 'Action rejetée par l’utilisateur' };
    }
    if (question && !(decision.status === 'edited' && hasAnswers(decision.updatedInput))) {
      return { allow: false, message: 'L’utilisateur n’a pas répondu à la question.' };
    }
    return decision.status === 'edited' && decision.updatedInput !== undefined
      ? { allow: true, updatedInput: decision.updatedInput }
      : { allow: true };
  };

  return {
    permissionTool: REGIS_PERMISSION_TOOL,
    authorize,
    resolve,
    async buildToolFlags(agent: Agent, tools: ToolInfo[]): Promise<ToolFlags> {
      const rules = await deps.listRules();
      const defaultWrite = await readDefaultWrite();
      const flags = buildToolFlags(rules, agent, tools, defaultWrite);
      const brainWritePolicies = REGIS_BRAIN_WRITE_TOOLS.map((tool) => ({
        tool,
        policy: resolvePolicyMatch(rules, agent.id, tool, 'write', defaultWrite).policy,
      }));
      const brainWriteToolsWith = (policy: Policy) =>
        brainWritePolicies.filter((entry) => entry.policy === policy).map((entry) => entry.tool);
      const renderPolicy = resolvePolicyMatch(
        rules,
        agent.id,
        REGIS_RENDER_TEMPLATE_TOOL,
        'write',
        defaultWrite,
      ).policy;
      return {
        allowed: [
          ...flags.allowed,
          ...(agent.canSpawn ? REGIS_JOB_TOOLS : []),
          ...REGIS_BRAIN_READ_TOOLS,
          ...brainWriteToolsWith('auto'),
          ...(renderPolicy === 'auto' ? [REGIS_RENDER_TEMPLATE_TOOL] : []),
        ],
        disallowed: [
          ...flags.disallowed,
          ...BUILT_IN_WRITE_TOOLS,
          ...brainWriteToolsWith('deny'),
          ...(renderPolicy === 'deny' ? [REGIS_RENDER_TEMPLATE_TOOL] : []),
        ],
      };
    },
    authorizeTool: (agent, tool, input, context) =>
      authorize({
        agentId: agent.id,
        jobId: context.jobId,
        qualifiedName: tool.qualifiedName,
        access: tool.access,
        input,
      }),
  };
}
