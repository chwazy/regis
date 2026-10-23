import { describe, expect, it } from 'vitest';
import type { Connector } from '@regis/shared';
import { createConnectorMethods } from './connectors';

describe('connectors.presets.build', () => {
  const build = createConnectorMethods()['connectors.presets.build'];

  it('builds the m365 connector without any manual command', async () => {
    const connector = (await build?.({ presetId: 'm365' })) as Connector;
    expect(connector).toMatchObject({
      id: '',
      kind: 'm365',
      transport: 'stdio',
      command: 'npx',
      secretRef: null,
      envJson: {},
      syncJson: { intervalMinutes: 5 },
    });
    expect(connector.argsJson).toEqual(expect.arrayContaining(['-y', '--preset', 'mail,calendar']));
    expect(String((connector.argsJson as string[])[1])).toMatch(/^@softeria\/ms-365-mcp-server@/);
  });

  it('passes the tenant and client id through the server environment', async () => {
    const connector = (await build?.({
      presetId: 'm365',
      options: { tenantId: 'contoso.example', clientId: 'client-guid' },
    })) as Connector;
    expect(connector.envJson).toEqual({
      MS365_MCP_TENANT_ID: 'contoso.example',
      MS365_MCP_CLIENT_ID: 'client-guid',
    });
  });

  it('rejects an unknown preset', () => {
    expect(() => build?.({ presetId: 'nope' })).toThrow(/Unknown connector preset/);
  });
});
