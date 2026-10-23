import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Approval, NewApproval, ToolInfo } from '@regis/shared';
import { ApprovalService } from '../approvals/service';
import { createToolPolicy } from '../policy/tool-policy';
import { createApprove } from './approve';
import { REGIS_AGENT_HEADER, REGIS_JOB_HEADER, RegisMcpServer } from './server';

interface PermissionFixture {
  request: Record<string, unknown>;
  allowResponse: unknown;
  denyResponse: { behavior: string; message: string };
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../tests/fixtures/claude-cli/permission-prompt.json', import.meta.url)),
    'utf8',
  ),
) as PermissionFixture;

const WRITE_TOOL: ToolInfo = {
  connectorId: 'c1',
  name: 'write_file',
  qualifiedName: 'mcp__filesystem__write_file',
  inputSchema: {},
  access: 'write',
};

interface Running {
  client: Client;
  service: ApprovalService;
  created: NewApproval[];
  rows: Approval[];
  stop: () => Promise<void>;
}

async function running(): Promise<Running> {
  const created: NewApproval[] = [];
  const rows: Approval[] = [];
  const service = new ApprovalService({
    store: {
      createApproval: (approval) => {
        created.push(approval);
        const row = { id: 'ap1', status: 'pending', ...approval } as Approval;
        rows.push(row);
        return Promise.resolve(row);
      },
      updateJob: () => Promise.resolve(),
      appendJobEvent: () => Promise.resolve(),
      getSetting: () => Promise.resolve('30'),
    },
    tools: { findTool: () => WRITE_TOOL, callTool: () => Promise.resolve({}) },
    onLog: () => undefined,
  });
  const policy = createToolPolicy({ listRules: () => Promise.resolve([]), approvals: service });
  const regis = new RegisMcpServer({
    approve: createApprove({
      authorize: (context, toolName, input) =>
        policy.authorize({
          agentId: context.agentId,
          jobId: context.jobId,
          qualifiedName: toolName,
          access: 'write',
          input,
        }),
    }),
    onLog: () => undefined,
  });
  const { url, token } = await regis.start();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}`, [REGIS_JOB_HEADER]: 'j1', [REGIS_AGENT_HEADER]: 'a1' },
      },
    }),
  );
  return {
    client,
    service,
    created,
    rows,
    stop: async () => {
      await client.close();
      await regis.stop();
    },
  };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text: string }[];
  return content[0]?.text ?? '';
}

async function waitForPending(created: NewApproval[]): Promise<void> {
  for (let attempt = 0; attempt < 200 && created.length === 0; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

describe('regis approve tool', () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it('creates a pending approval and answers allowResponse once approved', async () => {
    const { client, service, created, rows, stop } = await running();
    stops.push(stop);

    const pending = client.callTool({ name: 'approve', arguments: fixture.request });
    await waitForPending(created);
    expect(created[0]).toMatchObject({
      jobId: 'j1',
      tool: 'mcp__filesystem__write_file',
      decisionNote: null,
      decidedAt: null,
    });
    expect(rows[0]).toMatchObject({ id: 'ap1', status: 'pending', decidedAt: null });
    await service.resolve('ap1', { status: 'approved' });

    expect(textOf(await pending)).toBe(JSON.stringify(fixture.allowResponse));
  });

  it('answers a deny with the user note once rejected', async () => {
    const { client, service, created, stop } = await running();
    stops.push(stop);

    const pending = client.callTool({ name: 'approve', arguments: fixture.request });
    await waitForPending(created);
    await service.resolve('ap1', { status: 'rejected', note: fixture.denyResponse.message });

    expect(JSON.parse(textOf(await pending))).toEqual(fixture.denyResponse);
  });

  it('answers allow with updatedInput when the approval was edited', async () => {
    const { client, service, created, stop } = await running();
    stops.push(stop);

    const pending = client.callTool({ name: 'approve', arguments: fixture.request });
    await waitForPending(created);
    await service.resolve('ap1', { status: 'edited', updatedInput: { path: 'b', content: 'c' } });

    expect(JSON.parse(textOf(await pending))).toEqual({
      behavior: 'allow',
      updatedInput: { path: 'b', content: 'c' },
    });
  });
});
