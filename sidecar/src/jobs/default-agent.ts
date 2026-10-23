import type { Agent } from '@regis/shared';

export const DEFAULT_AGENT_SETTING = 'agents.defaultAgentId';

export async function resolveDefaultAgent(
  agents: Agent[],
  getSetting: (key: string) => Promise<string | null>,
): Promise<Agent | undefined> {
  const configuredId = await getSetting(DEFAULT_AGENT_SETTING);
  const enabled = agents.filter((agent) => agent.enabled);
  return enabled.find((agent) => agent.id === configuredId) ?? enabled[0];
}
