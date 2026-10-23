import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Connector, ConnectorStatus } from '@regis/shared';
import { McpCallError, McpHost, qualifyToolName, type McpHostOptions } from './host';

const ECHO_SERVER = fileURLToPath(new URL('../../../tests/servers/echo-mcp.mjs', import.meta.url));
const SECRET_VALUE = 'sup3r-s3cret-value';

function echoConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'c1',
    kind: 'mcp',
    name: 'Echo Test',
    transport: 'stdio',
    command: process.execPath,
    argsJson: [ECHO_SERVER],
    url: null,
    envJson: {},
    secretRef: null,
    enabled: true,
    syncJson: {},
    status: 'unknown',
    lastSyncAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((block) => block.text).join('');
}

function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('condition not met in time'));
      }
    }, 25);
  });
}

describe('McpHost', () => {
  const statuses: ConnectorStatus[] = [];
  const logs: string[] = [];
  let host: McpHost;

  function createHost(
    secrets: Record<string, string> = {},
    resolveLaunch?: McpHostOptions['resolveLaunch'],
  ): McpHost {
    statuses.length = 0;
    logs.length = 0;
    host = new McpHost({
      resolveSecret: (secretRef) => Promise.resolve(secrets[secretRef] ?? null),
      onStatus: (status) => statuses.push(status),
      onLog: (line) => logs.push(line),
      initialBackoffMs: 200,
      resolveLaunch,
    });
    return host;
  }

  afterEach(async () => {
    await host.stopAll();
  });

  it('launches with the command resolved at start instead of the stored one', async () => {
    createHost({}, () => Promise.resolve({ command: process.execPath, args: [ECHO_SERVER] }));
    const status = await host.start(
      echoConnector({ command: 'stale-path-that-does-not-exist', argsJson: [] }),
    );

    expect(status.state).toBe('connected');
  });

  it('lists tools with their read/write access and calls a tool', async () => {
    createHost();
    const status = await host.start(echoConnector());

    expect(status.state).toBe('connected');
    const tools = host.listTools('c1');
    expect(tools.map((tool) => [tool.name, tool.access])).toEqual(
      expect.arrayContaining([
        ['echo_read', 'read'],
        ['do_write', 'write'],
      ]),
    );
    expect(tools.find((tool) => tool.name === 'echo_read')?.qualifiedName).toBe('mcp__echo_test__echo_read');
    const result = await host.callTool('c1', 'echo_read', { text: 'a' });
    expect(textOf(result)).toContain('a');
  });

  it('returns tool errors as raw results and rejects calls on unknown connectors', async () => {
    createHost();
    await host.start(echoConnector());

    expect(await host.callTool('c1', 'missing_tool', {})).toMatchObject({ isError: true });
    await expect(host.callTool('unknown', 'echo_read', {})).rejects.toBeInstanceOf(McpCallError);
  });

  it('restarts a killed server and publishes every transition', async () => {
    createHost();
    await host.start(echoConnector());
    const pid = Number(textOf(await host.callTool('c1', 'get_pid', {})));
    statuses.length = 0;

    process.kill(pid);
    await waitFor(() => statuses.some((status) => status.state === 'error'), 5000);
    await waitFor(() => host.status('c1').state === 'connected', 5000);

    expect(statuses.map((status) => status.state)).toEqual(['error', 'starting', 'connected']);
    expect(Number(textOf(await host.callTool('c1', 'get_pid', {})))).not.toBe(pid);
  });

  it('injects the secret into the child environment without logging it', async () => {
    createHost({ 'ref-1': SECRET_VALUE });
    await host.start(
      echoConnector({
        secretRef: 'ref-1',
        envJson: { ECHO_LEAK_VARIABLE: 'MY_SECRET' },
        syncJson: { secretEnv: 'MY_SECRET' },
      }),
    );

    expect(textOf(await host.callTool('c1', 'env_has', { name: 'MY_SECRET' }))).toBe('true');
    await waitFor(() => logs.some((line) => line.includes('leaking')), 2000);
    expect(logs.some((line) => line.includes(SECRET_VALUE))).toBe(false);
    expect(JSON.stringify(statuses)).not.toContain(SECRET_VALUE);
  });

  it('reports a failing server without throwing and keeps retrying', async () => {
    createHost();
    const status = await host.start(echoConnector({ argsJson: ['--no-such-flag-for-node'] }));

    expect(status.state).toBe('error');
    expect(status.error).toBeTruthy();
    await host.stop('c1');
    expect(host.status('c1').state).toBe('stopped');
  });

  it('tests a connector without keeping it running', async () => {
    createHost();

    const result = await host.test(echoConnector());

    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(4);
    expect(host.status('c1').state).toBe('stopped');
  });
});

describe('qualifyToolName', () => {
  it('normalizes the connector name', () => {
    expect(qualifyToolName('Outlook / M365', 'list-mail-messages')).toBe(
      'mcp__outlook_m365__list-mail-messages',
    );
  });
});
