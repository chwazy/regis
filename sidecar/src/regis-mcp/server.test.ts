import { afterEach, describe, expect, it } from 'vitest';
import { RegisMcpServer } from './server';

const servers: RegisMcpServer[] = [];

async function started(): Promise<{ url: string; token: string }> {
  const server = new RegisMcpServer({
    approve: () => Promise.resolve({ behavior: 'allow' }),
    onLog: () => undefined,
  });
  servers.push(server);
  return server.start();
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  },
};

function post(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(INITIALIZE),
  });
}

describe('RegisMcpServer', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it('listens on the loopback interface only, on a random port', async () => {
    const { url } = await started();

    const parsed = new URL(url);
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(Number(parsed.port)).toBeGreaterThan(0);
  });

  it('rejects requests without the right bearer token with 401', async () => {
    const { url, token } = await started();

    expect((await post(url, {})).status).toBe(401);
    expect((await post(url, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(url, { authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it('uses a different token for each launch', async () => {
    const first = await started();
    const second = await started();

    expect(first.token).not.toBe(second.token);
    expect(first.token.length).toBeGreaterThanOrEqual(32);
  });
});
