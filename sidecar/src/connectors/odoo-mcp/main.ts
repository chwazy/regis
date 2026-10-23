import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OdooClient } from './client';
import { createOdooTools, DEFAULT_TIME_ZONE, runOdooTool } from './tools';

const REQUIRED_ENV = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY'] as const;

const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`regis-odoo-mcp: variables d'environnement manquantes : ${missing.join(', ')}`);
  process.exit(1);
}

const client = new OdooClient({
  url: process.env.ODOO_URL ?? '',
  db: process.env.ODOO_DB ?? '',
  login: process.env.ODOO_LOGIN ?? '',
  apiKey: process.env.ODOO_API_KEY ?? '',
});

const server = new McpServer({ name: 'regis-odoo-mcp', version: '0.1.0' });
for (const tool of createOdooTools(
  client,
  () => new Date(),
  process.env.REGIS_TIMEZONE || DEFAULT_TIME_ZONE,
)) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputShape,
      annotations: { readOnlyHint: tool.readOnly },
    },
    (input: Record<string, unknown>) => runOdooTool(tool, input),
  );
}

console.error('regis-odoo-mcp ready');
server.connect(new StdioServerTransport()).catch((error: unknown) => {
  console.error('regis-odoo-mcp: connexion stdio impossible :', error);
  process.exit(1);
});
