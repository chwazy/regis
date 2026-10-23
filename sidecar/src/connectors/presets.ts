import type { Connector } from '@regis/shared';

export interface PresetOptions {
  name?: string;
  tenantId?: string;
  clientId?: string;
  url?: string;
  db?: string;
  login?: string;
}

export interface ConnectorPreset {
  id: string;
  label: string;
  description: string;
  build: (options: PresetOptions) => Connector;
}

export const M365_PACKAGE = '@softeria/ms-365-mcp-server@0.170.2';

function draft(fields: Omit<Connector, 'id' | 'status' | 'lastSyncAt' | 'createdAt'>): Connector {
  return { id: '', status: 'unknown', lastSyncAt: null, createdAt: '', ...fields };
}

const m365: ConnectorPreset = {
  id: 'm365',
  label: 'Microsoft 365',
  description: 'Mails et agenda via le serveur MCP Softeria, connexion par code appareil.',
  build: (options) => {
    const env: Record<string, string> = {};
    if (options.tenantId) {
      env.MS365_MCP_TENANT_ID = options.tenantId;
    }
    if (options.clientId) {
      env.MS365_MCP_CLIENT_ID = options.clientId;
    }
    return draft({
      kind: 'm365',
      name: options.name?.trim() || 'Microsoft 365',
      transport: 'stdio',
      command: 'npx',
      argsJson: ['-y', M365_PACKAGE, '--preset', 'mail,calendar'],
      url: null,
      envJson: env,
      secretRef: null,
      enabled: true,
      syncJson: { intervalMinutes: 5 },
    });
  },
};

export const ODOO_SECRET_ENV = 'ODOO_API_KEY';
export const ODOO_DEV_ENTRY = 'sidecar/dist/odoo-mcp.js';
export const ODOO_BIN_ENV = 'REGIS_ODOO_MCP_BIN';
export const ODOO_ENTRY_ENV = 'REGIS_ODOO_MCP_ENTRY';

export const ODOO_PLACEHOLDER_COMMAND = 'regis-odoo-mcp';

export function odooLaunch(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const packagedBinary = env[ODOO_BIN_ENV];
  if (packagedBinary) {
    return { command: packagedBinary, args: [] };
  }
  return { command: 'node', args: [env[ODOO_ENTRY_ENV] || ODOO_DEV_ENTRY] };
}

const odoo: ConnectorPreset = {
  id: 'odoo',
  label: 'Odoo',
  description:
    'Clients, projets, tâches, heures et factures via le serveur MCP maison (API externe, clé API).',
  build: (options) => {
    return draft({
      kind: 'odoo',
      name: options.name?.trim() || 'Odoo',
      transport: 'stdio',
      command: ODOO_PLACEHOLDER_COMMAND,
      argsJson: [],
      url: null,
      envJson: {
        ODOO_URL: options.url?.trim() ?? '',
        ODOO_DB: options.db?.trim() ?? '',
        ODOO_LOGIN: options.login?.trim() ?? '',
      },
      secretRef: null,
      enabled: true,
      syncJson: { intervalMinutes: 15, secretEnv: ODOO_SECRET_ENV },
    });
  },
};

export const CONNECTOR_PRESETS: Record<string, ConnectorPreset> = {
  [m365.id]: m365,
  [odoo.id]: odoo,
};

export function buildFromPreset(presetId: string, options: PresetOptions = {}): Connector {
  const preset = CONNECTOR_PRESETS[presetId];
  if (!preset) {
    throw new Error(`Unknown connector preset: ${presetId}`);
  }
  return preset.build(options);
}
