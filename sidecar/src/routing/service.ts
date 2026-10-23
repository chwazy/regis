import type { Agent, RoutingRule } from '@regis/shared';
import { DriverUnavailableError, type AgentDriver } from '../agents/driver';
import { DEFAULT_AGENT_SETTING } from '../jobs/default-agent';
import { buildRoutingContext, type ContextDeps, type RoutingRequest } from './context';
import { NoEligibleAgentError, requiresLocal, route, type RoutingDecision } from './engine';
import { fallbackRoute } from './fallback';

export const ROUTER_AGENT_SETTING = 'routing.routerAgentId';

export interface RoutingServiceDeps extends ContextDeps {
  listRules: () => Promise<RoutingRule[]>;
  getDriver: (agent: Agent) => AgentDriver;
  getDataDir: () => Promise<string>;
}

export type DecideRoute = (request: RoutingRequest) => Promise<RoutingDecision>;

const unavailableRouter: AgentDriver = {
  runtime: 'ollama',
  // eslint-disable-next-line require-yield
  run: async function* () {
    await Promise.resolve();
    throw new DriverUnavailableError('aucun agent routeur configuré');
  },
  test: () => Promise.resolve({ ok: false, latencyMs: 0, costUsd: 0 }),
};

export function pickRouterAgent(
  agents: Agent[],
  configuredId: string | null,
  requireLocal: boolean,
): Agent | undefined {
  const usable = agents.filter((agent) => agent.enabled && (!requireLocal || agent.isLocalOnly));
  return (
    usable.find((agent) => agent.id === configuredId) ?? usable.find((agent) => agent.runtime === 'ollama')
  );
}

export function createRoutingService(deps: RoutingServiceDeps): { decide: DecideRoute } {
  const decide: DecideRoute = async (request) => {
    const [agents, rules] = await Promise.all([deps.listAgents(), deps.listRules()]);
    const ctx = await buildRoutingContext(deps, request);
    const byRule = route(ctx, rules, agents);
    if (byRule) {
      return byRule;
    }
    const requireLocal = requiresLocal(ctx, rules);
    const eligible = agents.filter((agent) => agent.enabled && (!requireLocal || agent.isLocalOnly));
    if (eligible.length === 0) {
      throw new NoEligibleAgentError(
        requireLocal ? 'Aucun agent local actif pour une tâche réservée au local' : 'Aucun agent disponible',
      );
    }
    const configuredDefault = await deps.getSetting(DEFAULT_AGENT_SETTING);
    const routerAgent = pickRouterAgent(agents, await deps.getSetting(ROUTER_AGENT_SETTING), requireLocal);
    return fallbackRoute(
      request.task,
      ctx,
      eligible,
      routerAgent ? deps.getDriver(routerAgent) : unavailableRouter,
      {
        requireLocal,
        defaultAgentId: configuredDefault,
        ...(routerAgent ? { routerAgent } : {}),
        cwd: await deps.getDataDir(),
      },
    );
  };
  return { decide };
}
