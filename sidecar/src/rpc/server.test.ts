import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RpcErrorCode, type PingResult, type RpcResponse } from '@regis/shared';
import { createMethods } from '../methods';
import { RpcServer } from './server';

function startServer(): { send: (message: object) => void; next: () => Promise<RpcResponse> } {
  const input = new PassThrough();
  const output = new PassThrough();
  new RpcServer({ input, output, methods: createMethods() }).start();
  const replies: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else replies.push(line);
    }
  });
  return {
    send: (message) => input.write(`${JSON.stringify(message)}\n`),
    next: () =>
      new Promise<RpcResponse>((resolve) => {
        const ready = replies.shift();
        if (ready) resolve(JSON.parse(ready) as RpcResponse);
        else waiters.push((line) => resolve(JSON.parse(line) as RpcResponse));
      }),
  };
}

describe('rpc server', () => {
  it('answers system.ping with a PingResult', async () => {
    const server = startServer();
    server.send({ jsonrpc: '2.0', id: 1, method: 'system.ping' });
    const response = await server.next();
    const result = response.result as PingResult;
    expect(response.id).toBe(1);
    expect(result.name).toBe('regis-sidecar');
    expect(result.pid).toBe(process.pid);
    expect(result.version.length).toBeGreaterThan(0);
  });

  it('returns MethodNotFound for an unknown method', async () => {
    const server = startServer();
    server.send({ jsonrpc: '2.0', id: 2, method: 'nope.nothing' });
    const response = await server.next();
    expect(response.error?.code).toBe(RpcErrorCode.MethodNotFound);
  });
});
