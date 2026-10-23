import { z } from 'zod';
import type { Agent } from '@regis/shared';
import type { AgentDriver } from '../agents/driver';
import { NoEligibleAgentError, type RoutingContext, type RoutingDecision } from './engine';

export interface FallbackOptions {
  requireLocal?: boolean;
  defaultAgentId?: string | null;
  routerAgent?: Agent;
  cwd?: string;
  timeoutMs?: number;
}

const ROUTER_TIMEOUT_MS = 30_000;
const routerAnswer = z.object({ agentId: z.string(), reason: z.string() });

export const ROUTER_SYSTEM_PROMPT =
  'You pick the best agent for a task. Reply with JSON only: {"agentId": "<id>", "reason": "<short explanation in French>"}. The agentId must be one of the listed agents.';

export function buildRouterPrompt(task: string, ctx: RoutingContext, eligible: Agent[]): string {
  const catalog = eligible
    .map(
      (agent) => `- ${agent.id} (${agent.name}) : ${agent.useWhen === '' ? 'aucun indice' : agent.useWhen}`,
    )
    .join('\n');
  return `Tâche (type : ${ctx.taskType}) :\n${task}\n\nAgents éligibles :\n${catalog}`;
}

export function parseRouterAnswer(text: string): { agentId: string; reason: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = routerAnswer.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function askRouter(
  prompt: string,
  routerAgent: Agent,
  router: AgentDriver,
  options: FallbackOptions,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ROUTER_TIMEOUT_MS);
  try {
    let resultText = '';
    for await (const event of router.run({
      jobId: '',
      agent: routerAgent,
      prompt,
      systemPrompt: ROUTER_SYSTEM_PROMPT,
      cwd: options.cwd ?? process.cwd(),
      maxTurns: 1,
      jsonOutput: true,
      signal: controller.signal,
    })) {
      if (event.type === 'end') {
        if (event.isError) {
          throw new Error('le routeur a échoué');
        }
        resultText = event.resultText;
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
    return resultText;
  } finally {
    clearTimeout(timer);
  }
}

export async function fallbackRoute(
  task: string,
  ctx: RoutingContext,
  eligible: Agent[],
  router: AgentDriver,
  options: FallbackOptions = {},
): Promise<RoutingDecision> {
  const candidates = eligible.filter(
    (agent) => agent.enabled && (options.requireLocal !== true || agent.isLocalOnly),
  );
  const fallbackAgent = candidates.find((agent) => agent.id === options.defaultAgentId) ?? candidates[0];
  if (!fallbackAgent) {
    throw new NoEligibleAgentError(
      options.requireLocal === true
        ? 'Aucun agent local actif pour une tâche réservée au local'
        : 'Aucun agent disponible',
    );
  }
  const defaulted = (why: string): RoutingDecision => ({
    agentId: fallbackAgent.id,
    ruleId: null,
    reason: `${why} — agent par défaut`,
    viaFallback: true,
  });
  let answer: ReturnType<typeof parseRouterAnswer>;
  try {
    const text = await askRouter(
      buildRouterPrompt(task, ctx, candidates),
      options.routerAgent ?? fallbackAgent,
      router,
      options,
    );
    answer = parseRouterAnswer(text);
  } catch (error) {
    return defaulted(`Routeur indisponible (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!answer) {
    return defaulted('Réponse du routeur illisible');
  }
  const chosen = candidates.find((agent) => agent.id === answer.agentId);
  if (!chosen) {
    return defaulted(`Le routeur a proposé un agent non éligible (${answer.agentId})`);
  }
  return { agentId: chosen.id, ruleId: null, reason: answer.reason, viaFallback: true };
}
