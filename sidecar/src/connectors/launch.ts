import { z } from 'zod';
import type { Connector } from '@regis/shared';
import type { ConnectorLaunch } from '../mcp/host';
import { DEFAULT_TIMEZONE } from '../routing/engine';
import { TIMEZONE_SETTING } from '../routing/context';
import { odooLaunch } from './presets';

export const ODOO_TIMEZONE_ENV = 'REGIS_TIMEZONE';

const configuredTimezone = z.object({ [ODOO_TIMEZONE_ENV]: z.string().min(1) });

/** Un `REGIS_TIMEZONE` saisi dans l'env du connecteur prime sur `app.timezone`. */
function hasConfiguredTimezone(connector: Connector): boolean {
  return configuredTimezone.safeParse(connector.envJson).success;
}

export function createLaunchResolver(
  getSetting: (key: string) => Promise<string | null>,
  processEnv: NodeJS.ProcessEnv = process.env,
): (connector: Connector) => Promise<ConnectorLaunch | null> {
  return async (connector) => {
    if (connector.kind !== 'odoo') {
      return null;
    }
    if (hasConfiguredTimezone(connector)) {
      return odooLaunch(processEnv);
    }
    const timezone = (await getSetting(TIMEZONE_SETTING)) || DEFAULT_TIMEZONE;
    return { ...odooLaunch(processEnv), env: { [ODOO_TIMEZONE_ENV]: timezone } };
  };
}
