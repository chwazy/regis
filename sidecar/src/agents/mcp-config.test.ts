import { describe, expect, it } from 'vitest';
import type { Connector } from '@regis/shared';
import { createLaunchResolver } from '../connectors/launch';
import { ODOO_DEV_ENTRY, buildFromPreset } from '../connectors/presets';
import { qualifyToolName } from '../mcp/host';
import { buildClaudeEnv, buildMcpConfig, serverKey } from './mcp-config';

function connector(overrides: Partial<Connector>): Connector {
  return {
    id: 'c1',
    kind: 'mcp',
    name: 'Files Server',
    transport: 'stdio',
    command: 'npx',
    argsJson: ['-y', 'pkg'],
    url: null,
    envJson: { PLAIN: 'value' },
    secretRef: null,
    enabled: true,
    syncJson: {},
    status: 'unknown',
    lastSyncAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildMcpConfig', () => {
  it('uses the same server key as the qualified tool names', () => {
    expect(qualifyToolName('Files Server', 'read')).toBe(`mcp__${serverKey('Files Server')}__read`);
  });

  it('keeps secrets out of the config and exposes them through placeholders', async () => {
    const { config, secretEnv } = await buildMcpConfig(
      [
        connector({ secretRef: 'ref-1', syncJson: { secretEnv: 'API_TOKEN' } }),
        connector({ id: 'c2', name: 'Remote', transport: 'http', url: 'http://x/mcp', secretRef: 'ref-2' }),
        connector({ id: 'c3', name: 'Internal', transport: 'builtin', command: null }),
      ],
      (ref) => Promise.resolve(`value-of-${ref}`),
    );

    expect(Object.keys(config.mcpServers)).toEqual(['files_server', 'remote']);
    expect(JSON.stringify(config)).not.toContain('value-of-');
    expect(config.mcpServers.files_server).toMatchObject({
      env: { PLAIN: 'value', API_TOKEN: '${REGIS_MCP_SECRET_FILES_SERVER}' },
    });
    expect(config.mcpServers.remote).toMatchObject({
      type: 'http',
      headers: { Authorization: 'Bearer ${REGIS_MCP_SECRET_REMOTE}' },
    });
    expect(secretEnv).toEqual({
      REGIS_MCP_SECRET_FILES_SERVER: 'value-of-ref-1',
      REGIS_MCP_SECRET_REMOTE: 'value-of-ref-2',
    });
  });
});

describe('buildMcpConfig launch resolution', () => {
  const resolveLaunch = createLaunchResolver(() => Promise.resolve('Pacific/Auckland'), {});
  const odoo = (overrides: Partial<Connector> = {}): Connector => ({
    ...buildFromPreset('odoo'),
    id: 'odoo-1',
    ...overrides,
  });

  it('resolves the odoo placeholder command and injects the timezone', async () => {
    const { config } = await buildMcpConfig([odoo()], () => Promise.resolve(null), resolveLaunch);

    expect(config.mcpServers[serverKey(odoo().name)]).toMatchObject({
      command: 'node',
      args: [ODOO_DEV_ENTRY],
      env: { REGIS_TIMEZONE: 'Pacific/Auckland' },
    });
  });

  it('replaces a stale frozen odoo command', async () => {
    const stale = odoo({ command: 'node', argsJson: ['C:/old/install/odoo-mcp.js'] });
    const { config } = await buildMcpConfig([stale], () => Promise.resolve(null), resolveLaunch);

    expect(config.mcpServers[serverKey(stale.name)]).toMatchObject({
      command: 'node',
      args: [ODOO_DEV_ENTRY],
    });
    expect(JSON.stringify(config)).not.toContain('C:/old/install');
  });

  it('keeps the secret as a placeholder next to the resolved launch', async () => {
    const { config, secretEnv } = await buildMcpConfig(
      [odoo({ secretRef: 'ref-odoo' })],
      () => Promise.resolve('odoo-api-key'),
      resolveLaunch,
    );

    expect(JSON.stringify(config)).not.toContain('odoo-api-key');
    expect(Object.values(secretEnv)).toEqual(['odoo-api-key']);
  });

  it('leaves non-odoo connectors untouched', async () => {
    const { config } = await buildMcpConfig([connector({})], () => Promise.resolve(null), resolveLaunch);

    expect(config.mcpServers.files_server).toMatchObject({ command: 'npx', args: ['-y', 'pkg'] });
    expect(config.mcpServers.files_server).toMatchObject({ env: { PLAIN: 'value' } });
  });
});

describe('buildClaudeEnv', () => {
  it('forwards only the base and Claude variables, plus the job secrets', () => {
    const env = buildClaudeEnv(
      { REGIS_MCP_SECRET_X: 's' },
      {
        PATH: '/bin',
        USERPROFILE: 'home',
        CLAUDE_CONFIG_DIR: 'cfg',
        ANTHROPIC_API_KEY: 'sk-other',
        REGIS_CONNECTOR_SECRET: 'leak',
        GITHUB_TOKEN: 'leak',
      },
    );

    expect(env).toEqual({
      PATH: '/bin',
      USERPROFILE: 'home',
      CLAUDE_CONFIG_DIR: 'cfg',
      REGIS_MCP_SECRET_X: 's',
    });
  });
});
