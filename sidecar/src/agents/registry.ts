import type { Agent, Connector } from '@regis/shared';
import type { RegisMcpEndpoint } from '../regis-mcp/server';
import type { ConnectorLaunch, McpHost } from '../mcp/host';
import { ACP_ENABLED, AcpDriver, resolveGeminiCommand } from './acp';
import { AnthropicApiDriver } from './anthropic-api';
import { resolveClaudeBin } from './claude-bin';
import { ClaudeCliDriver } from './claude-cli';
import { denyWritesPolicy } from './deny-writes-policy';
import { DriverUnavailableError, type AgentDriver, type AgentToolPolicy } from './driver';
import { OllamaDriver } from './ollama';

export interface AgentStore {
  listAgents: () => Promise<Agent[]>;
  listConnectors: () => Promise<Connector[]>;
  getSetting: (key: string) => Promise<string | null>;
}

export interface AgentRegistryDeps {
  mcpHost: Pick<McpHost, 'listTools' | 'callTool'>;
  store: AgentStore;
  resolveSecret: (secretRef: string) => Promise<string | null>;
  resolveLaunch?: (connector: Connector) => Promise<ConnectorLaunch | null>;
  onLog: (line: string) => void;
  policy?: AgentToolPolicy;
  regisEndpoint?: () => Promise<RegisMcpEndpoint>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
  acpEnabled?: boolean;
}

export function createDriverRegistry(deps: AgentRegistryDeps): { getDriver: (agent: Agent) => AgentDriver } {
  const policy = deps.policy ?? denyWritesPolicy;
  const drivers = new Map<string, AgentDriver>();
  const create = (agent: Agent): AgentDriver => {
    switch (agent.runtime) {
      case 'claude-cli':
        return new ClaudeCliDriver({
          resolveBin: () =>
            resolveClaudeBin({
              getSetting: (key) => deps.store.getSetting(key),
              ...(deps.env ? { env: deps.env } : {}),
            }),
          listConnectors: deps.store.listConnectors,
          listTools: (connectorId) => deps.mcpHost.listTools(connectorId),
          resolveSecret: deps.resolveSecret,
          ...(deps.resolveLaunch ? { resolveLaunch: deps.resolveLaunch } : {}),
          policy,
          ...(deps.regisEndpoint ? { regisEndpoint: deps.regisEndpoint } : {}),
          onLog: deps.onLog,
          ...(deps.extraEnv ? { extraEnv: deps.extraEnv } : {}),
        });
      case 'anthropic-api':
        return new AnthropicApiDriver({
          resolveSecret: deps.resolveSecret,
          getSetting: deps.store.getSetting,
          tools: {
            listTools: (connectorId) => deps.mcpHost.listTools(connectorId),
            callTool: (connectorId, tool, args) => deps.mcpHost.callTool(connectorId, tool, args),
          },
          policy,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
      case 'ollama':
        return new OllamaDriver({
          getSetting: deps.store.getSetting,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
      case 'gemini-cli':
        if (!(deps.acpEnabled ?? ACP_ENABLED)) {
          throw new DriverUnavailableError(
            'Gemini CLI (ACP) est désactivé : aucune session réelle n’a été vérifiée',
          );
        }
        if (agent.mode !== 'acp') {
          throw new DriverUnavailableError('Gemini CLI n’est pilotable qu’en mode ACP');
        }
        return new AcpDriver({
          runtime: 'gemini-cli',
          resolveCommand: (target) =>
            resolveGeminiCommand(
              { getSetting: (key) => deps.store.getSetting(key), ...(deps.env ? { env: deps.env } : {}) },
              target,
            ),
          policy,
          resolveSecret: deps.resolveSecret,
          onLog: deps.onLog,
          ...(deps.extraEnv ? { extraEnv: deps.extraEnv } : {}),
        });
      default:
        throw new DriverUnavailableError(`Le runtime ${agent.runtime} est prévu mais pas encore disponible`);
    }
  };
  return {
    getDriver: (agent) => {
      const existing = drivers.get(agent.runtime);
      if (existing) {
        return existing;
      }
      const driver = create(agent);
      drivers.set(agent.runtime, driver);
      return driver;
    },
  };
}
