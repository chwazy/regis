import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_API_KEY,
  FAKE_DB,
  FAKE_LOGIN,
  startFakeOdoo,
  type FakeOdoo,
} from '../../../../tests/servers/fake-odoo.mjs';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const REQUIRE_BANNER =
  "import { createRequire as __regisCreateRequire } from 'node:module'; const require = __regisCreateRequire(import.meta.url);";
const READ_TOOLS = [
  'partner_search',
  'project_list',
  'project_read',
  'task_list',
  'timesheet_list',
  'invoice_list',
  'invoice_read',
];
const WRITE_TOOLS = ['timesheet_create', 'task_update_stage'];

let odoo: FakeOdoo;
let client: Client;
let workDir: string;

beforeAll(async () => {
  odoo = await startFakeOdoo();
  workDir = mkdtempSync(join(tmpdir(), 'regis-odoo-mcp-'));
  const bundle = join(workDir, 'odoo-mcp.mjs');
  await build({
    entryPoints: [MAIN],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundle,
    banner: { js: REQUIRE_BANNER },
  });
  client = new Client({ name: 'tools-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      env: {
        PATH: process.env.PATH ?? '',
        ODOO_URL: odoo.url,
        ODOO_DB: FAKE_DB,
        ODOO_LOGIN: FAKE_LOGIN,
        ODOO_API_KEY: FAKE_API_KEY,
      },
      stderr: 'ignore',
    }),
  );
}, 60_000);

afterAll(async () => {
  await client.close();
  await odoo.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('regis-odoo-mcp', () => {
  it('lists exactly the contract tools with the right readOnlyHint', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(READ_TOOLS.includes(tool.name));
    }
  });

  it('timesheet_create sends a create on account.analytic.line with unit_amount', async () => {
    const result = await client.callTool({
      name: 'timesheet_create',
      arguments: { projectId: 3, date: '2026-10-21', hours: 2.5, description: 'x' },
    });
    expect(result.isError).toBeFalsy();
    const call = odoo.journal.find(
      (entry) => entry.model === 'account.analytic.line' && entry.odooMethod === 'create',
    );
    expect(call?.args).toEqual([{ project_id: 3, date: '2026-10-21', unit_amount: 2.5, name: 'x' }]);
  });

  it.each([0, -1, 24.5])('timesheet_create rejects %s hours without calling Odoo', async (hours) => {
    const before = odoo.journal.length;
    const result = await client.callTool({
      name: 'timesheet_create',
      arguments: { projectId: 3, date: '2026-10-21', hours, description: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(odoo.journal.length).toBe(before);
  });

  it('task_update_stage writes stage_id on project.task', async () => {
    await client.callTool({ name: 'task_update_stage', arguments: { taskId: 21, stageId: 2 } });
    const call = odoo.journal.find((entry) => entry.model === 'project.task' && entry.odooMethod === 'write');
    expect(call?.args).toEqual([[21], { stage_id: 2 }]);
  });
});
