import { describe, expect, it } from 'vitest';
import type { Connector } from '@regis/shared';
import { createLaunchResolver } from './launch';
import { ODOO_BIN_ENV, ODOO_DEV_ENTRY, ODOO_ENTRY_ENV, buildFromPreset } from './presets';

function odooConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    ...buildFromPreset('odoo'),
    command: 'node',
    argsJson: ['C:/old/install/odoo-mcp.js'],
    ...overrides,
  };
}

describe('createLaunchResolver', () => {
  const settings: Record<string, string> = {};
  const getSetting = (key: string): Promise<string | null> => Promise.resolve(settings[key] ?? null);

  it('does not alter the launch of non-odoo connectors', async () => {
    const resolve = createLaunchResolver(getSetting, {});
    expect(await resolve(buildFromPreset('m365'))).toBeNull();
  });

  it('resolves the dev entry at launch, ignoring a stale stored command', async () => {
    const resolve = createLaunchResolver(getSetting, {});
    const launch = await resolve(odooConnector());
    expect(launch).toMatchObject({ command: 'node', args: [ODOO_DEV_ENTRY] });
  });

  it('honours the entry and binary overrides', async () => {
    expect(
      await createLaunchResolver(getSetting, { [ODOO_ENTRY_ENV]: 'x.js' })(odooConnector()),
    ).toMatchObject({
      command: 'node',
      args: ['x.js'],
    });
    expect(await createLaunchResolver(getSetting, { [ODOO_BIN_ENV]: 'bin' })(odooConnector())).toMatchObject({
      command: 'bin',
      args: [],
    });
  });

  it('passes the app timezone, defaulting to Europe/Zurich', async () => {
    const resolve = createLaunchResolver(getSetting, {});
    expect((await resolve(odooConnector()))?.env).toEqual({ REGIS_TIMEZONE: 'Europe/Zurich' });
    settings['app.timezone'] = 'Pacific/Auckland';
    expect((await resolve(odooConnector()))?.env).toEqual({ REGIS_TIMEZONE: 'Pacific/Auckland' });
  });

  it('keeps an explicit REGIS_TIMEZONE from the connector env', async () => {
    const resolve = createLaunchResolver(() => Promise.resolve('Pacific/Auckland'), {});
    const launch = await resolve(
      odooConnector({ envJson: { REGIS_TIMEZONE: 'America/New_York', OTHER: 'x' } }),
    );
    expect(launch).toMatchObject({ command: 'node', args: [ODOO_DEV_ENTRY] });
    expect(launch?.env).toBeUndefined();
  });

  it('still passes the app timezone when the connector env has no usable REGIS_TIMEZONE', async () => {
    const resolve = createLaunchResolver(() => Promise.resolve('Pacific/Auckland'), {});
    for (const envJson of [{}, { REGIS_TIMEZONE: '' }, { OTHER: 'x' }, null]) {
      expect((await resolve(odooConnector({ envJson })))?.env).toEqual({
        REGIS_TIMEZONE: 'Pacific/Auckland',
      });
    }
  });

  it('drafts the odoo preset without a resolved path', () => {
    const draft = buildFromPreset('odoo');
    expect(draft.argsJson).toEqual([]);
    expect(JSON.stringify(draft)).not.toContain('odoo-mcp.js');
  });
});
