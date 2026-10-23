import type { Agent, ToolInfo } from '@regis/shared';
import { resolvePolicy, type DefaultWrite, type PolicyRule } from './resolve';

export function buildToolFlags(
  rules: PolicyRule[],
  agent: Agent,
  tools: ToolInfo[],
  defaultWrite: DefaultWrite = 'ask',
): { allowed: string[]; disallowed: string[] } {
  const allowed: string[] = [];
  const disallowed: string[] = [];
  for (const tool of tools) {
    const policy = resolvePolicy(rules, agent.id, tool.qualifiedName, tool.access, defaultWrite);
    if (policy === 'auto') {
      allowed.push(tool.qualifiedName);
    } else if (policy === 'deny') {
      disallowed.push(tool.qualifiedName);
    }
  }
  return { allowed, disallowed };
}
