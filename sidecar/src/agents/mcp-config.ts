import { z } from 'zod';
import type { Connector } from '@regis/shared';
import type { ConnectorLaunch } from '../mcp/host';

const DEFAULT_SECRET_ENV = 'REGIS_CONNECTOR_SECRET';
const stringList = z.array(z.string());
const stringRecord = z.record(z.string(), z.string());
const secretEnvSettings = z.object({ secretEnv: z.string().optional() });

export type McpServerConfig =
  | { command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface BuiltMcpConfig {
  config: McpConfig;
  secretEnv: Record<string, string>;
}

export function serverKey(connectorName: string): string {
  return connectorName.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
}

export function allowedConnectorIds(connectorIdsJson: unknown): string[] {
  return stringList.catch([]).parse(connectorIdsJson);
}

export async function buildMcpConfig(
  connectors: Connector[],
  resolveSecret: (secretRef: string) => Promise<string | null>,
  resolveLaunch?: (connector: Connector) => Promise<ConnectorLaunch | null>,
): Promise<BuiltMcpConfig> {
  const mcpServers: Record<string, McpServerConfig> = {};
  const secretEnv: Record<string, string> = {};
  for (const connector of connectors) {
    if (connector.transport !== 'stdio' && connector.transport !== 'http') {
      continue;
    }
    const key = serverKey(connector.name);
    const secret = connector.secretRef ? await resolveSecret(connector.secretRef) : null;
    const placeholder = `REGIS_MCP_SECRET_${key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
    if (secret) {
      secretEnv[placeholder] = secret;
    }
    if (connector.transport === 'stdio') {
      if (!connector.command) {
        continue;
      }
      const secretName =
        secretEnvSettings.safeParse(connector.syncJson).data?.secretEnv ?? DEFAULT_SECRET_ENV;
      const launch = (await resolveLaunch?.(connector)) ?? null;
      mcpServers[key] = {
        command: launch?.command ?? connector.command,
        args: launch?.args ?? stringList.catch([]).parse(connector.argsJson),
        env: {
          ...stringRecord.catch({}).parse(connector.envJson),
          ...launch?.env,
          ...(secret ? { [secretName]: `\${${placeholder}}` } : {}),
        },
      };
    } else if (connector.url) {
      mcpServers[key] = {
        type: 'http',
        url: connector.url,
        headers: secret ? { Authorization: `Bearer \${${placeholder}}` } : {},
      };
    }
  }
  return { config: { mcpServers }, secretEnv };
}

const BASE_ENV_NAMES = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMROOT',
  'SystemRoot',
  'SYSTEMDRIVE',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERNAME',
  'LANG',
  'LC_ALL',
  'SHELL',
  'TERM',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
];
const CLAUDE_ENV_PREFIX = 'CLAUDE_';

export function buildMinimalEnv(
  secretEnv: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
  prefixes: string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    const upper = name.toUpperCase();
    const isBase = BASE_ENV_NAMES.some((base) => base.toUpperCase() === upper);
    if (isBase || prefixes.some((prefix) => upper.startsWith(prefix))) {
      env[name] = value;
    }
  }
  return { ...env, ...secretEnv };
}

export function buildClaudeEnv(
  secretEnv: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return buildMinimalEnv(secretEnv, source, [CLAUDE_ENV_PREFIX]);
}
