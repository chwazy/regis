import { z } from 'zod';
import { RpcErrorCode, type Agent } from '@regis/shared';
import {
  CLAUDE_BIN_ENV,
  FIXTURE_CLAUDE_VERSION,
  readClaudeVersion,
  resolveClaudeBin,
} from '../../agents/claude-bin';
import { DriverUnavailableError, type AgentDriver, type AgentTestResult } from '../../agents/driver';
import { resolveOllamaUrl } from '../../agents/ollama';
import { isDemoMode } from '../../demo/seed';
import { RpcMethodError, type MethodHandler } from '../server';

export interface AgentsHandlerDeps {
  listAgents: () => Promise<Agent[]>;
  getSetting: (key: string) => Promise<string | null>;
  getDriver: (agent: Agent) => AgentDriver;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface DetectResult {
  /** `simulated` : mode démo, la CLI est le faux binaire des fixtures. */
  claude?: { path: string; version: string; simulated?: true };
  ollama?: { url: string; models: string[] };
}

const testParams = z.object({ agentId: z.string().min(1) });
const tagsResponse = z.object({ models: z.array(z.object({ name: z.string() })) });
const OLLAMA_DETECT_TIMEOUT_MS = 2000;

export function createAgentsMethods(deps: AgentsHandlerDeps): Record<string, MethodHandler> {
  return {
    'agents.test': async (params): Promise<AgentTestResult> => {
      const parsed = testParams.safeParse(params ?? {});
      if (!parsed.success) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
      }
      const agent = (await deps.listAgents()).find((candidate) => candidate.id === parsed.data.agentId);
      if (!agent) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, `Agent inconnu : ${parsed.data.agentId}`);
      }
      try {
        return await deps.getDriver(agent).test(agent);
      } catch (error) {
        if (error instanceof DriverUnavailableError) {
          return { ok: false, latencyMs: 0, costUsd: 0, error: error.message };
        }
        throw error;
      }
    },
    'agents.detect': async (): Promise<DetectResult> => {
      const [claude, ollama] = await Promise.all([detectClaude(deps), detectOllama(deps)]);
      return { ...(claude ? { claude } : {}), ...(ollama ? { ollama } : {}) };
    },
  };
}

async function detectClaude(deps: AgentsHandlerDeps): Promise<DetectResult['claude']> {
  const env = deps.env ?? process.env;
  const simulated = isDemoMode(env);
  try {
    const path = await resolveClaudeBin({
      getSetting: deps.getSetting,
      ...(deps.env ? { env: deps.env } : {}),
    });
    return {
      path,
      version: await readClaudeVersion(path),
      ...(simulated ? { simulated: true as const } : {}),
    };
  } catch {
    return simulated
      ? { path: env[CLAUDE_BIN_ENV] || 'claude', version: FIXTURE_CLAUDE_VERSION, simulated: true }
      : undefined;
  }
}

async function detectOllama(deps: AgentsHandlerDeps): Promise<DetectResult['ollama']> {
  const url = await resolveOllamaUrl(deps.getSetting);
  try {
    const response = await (deps.fetch ?? fetch)(`${url}/api/tags`, {
      signal: AbortSignal.timeout(OLLAMA_DETECT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    const tags = tagsResponse.parse(await response.json());
    return { url, models: tags.models.map((model) => model.name) };
  } catch {
    return undefined;
  }
}
