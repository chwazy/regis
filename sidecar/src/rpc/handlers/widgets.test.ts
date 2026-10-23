import { describe, expect, it } from 'vitest';
import { RpcErrorCode, type ToolInfo } from '@regis/shared';
import { createWidgetsMethods, MCP_TOOL_ALLOWLIST_SETTING } from './widgets';
import { RpcMethodError } from '../server';

function tool(overrides: Partial<ToolInfo> & { name: string }): ToolInfo {
  return {
    connectorId: 'c1',
    qualifiedName: `mcp__odoo__${overrides.name}`,
    inputSchema: {},
    access: 'read',
    ...overrides,
  };
}

function setup(tools: ToolInfo[], settings: Record<string, string> = {}) {
  const calls: { tool: string; args: unknown }[] = [];
  const handlers = createWidgetsMethods({
    findTool: (_connectorId, name) => tools.find((candidate) => candidate.name === name),
    callTool: (_connectorId, name, args) => {
      calls.push({ tool: name, args });
      return Promise.resolve({ content: [{ type: 'text', text: '{"ok":true}' }] });
    },
    getSetting: (key) => Promise.resolve(settings[key] ?? null),
  });
  const run = (name: string): Promise<unknown> =>
    Promise.resolve(handlers['widgets.mcpTool']?.({ connectorId: 'c1', tool: name, args: { a: 1 } }));
  return { run, calls };
}

async function codeOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof RpcMethodError ? error.code : -1;
  }
}

describe('widgets.mcpTool', () => {
  it('denies a tool classified as write without calling it', async () => {
    const { run, calls } = setup([tool({ name: 'timesheet_create', access: 'write', readOnlyHint: true })]);

    expect(await codeOf(run('timesheet_create'))).toBe(RpcErrorCode.PolicyDenied);
    expect(calls).toEqual([]);
  });

  it('denies a tool that only looks read-only by its name', async () => {
    const { run, calls } = setup([tool({ name: 'list_projects' })]);

    expect(await codeOf(run('list_projects'))).toBe(RpcErrorCode.PolicyDenied);
    expect(calls).toEqual([]);
  });

  it('calls a tool with an explicit read-only hint', async () => {
    const { run, calls } = setup([tool({ name: 'list_projects', readOnlyHint: true })]);

    await run('list_projects');

    expect(calls).toEqual([{ tool: 'list_projects', args: { a: 1 } }]);
  });

  it('calls a tool without hint when the user allowlisted it', async () => {
    const { run, calls } = setup([tool({ name: 'list_projects' })], {
      [MCP_TOOL_ALLOWLIST_SETTING]: JSON.stringify(['mcp__odoo__list_projects']),
    });

    await run('list_projects');

    expect(calls).toHaveLength(1);
  });

  it('never calls a write tool even when it is allowlisted', async () => {
    const { run, calls } = setup([tool({ name: 'send_mail', access: 'write' })], {
      [MCP_TOOL_ALLOWLIST_SETTING]: JSON.stringify(['mcp__odoo__send_mail']),
    });

    expect(await codeOf(run('send_mail'))).toBe(RpcErrorCode.PolicyDenied);
    expect(calls).toEqual([]);
  });

  it('reports an unknown tool as unavailable', async () => {
    const { run } = setup([]);

    expect(await codeOf(run('missing'))).toBe(RpcErrorCode.Unavailable);
  });

  it('ignores a corrupted allowlist', async () => {
    const { run, calls } = setup([tool({ name: 'list_projects' })], {
      [MCP_TOOL_ALLOWLIST_SETTING]: '{not json',
    });

    expect(await codeOf(run('list_projects'))).toBe(RpcErrorCode.PolicyDenied);
    expect(calls).toEqual([]);
  });
});
