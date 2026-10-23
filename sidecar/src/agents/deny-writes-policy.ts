import type { Agent, ToolInfo } from '@regis/shared';
import type { AgentToolPolicy, ToolDecision, ToolFlags } from './driver';

export const BUILT_IN_WRITE_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit'];

export const denyWritesPolicy: AgentToolPolicy = {
  buildToolFlags(_agent: Agent, tools: ToolInfo[]): ToolFlags {
    return {
      allowed: tools.filter((tool) => tool.access === 'read').map((tool) => tool.qualifiedName),
      disallowed: [
        ...tools.filter((tool) => tool.access === 'write').map((tool) => tool.qualifiedName),
        ...BUILT_IN_WRITE_TOOLS,
      ],
    };
  },
  authorizeTool(_agent: Agent, tool: ToolInfo): Promise<ToolDecision> {
    if (tool.access === 'write') {
      return Promise.resolve({
        allow: false,
        message: `Écriture refusée par défaut : ${tool.qualifiedName}`,
      });
    }
    return Promise.resolve({ allow: true });
  },
};
