import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DriverUnavailableError } from './driver';
import { OllamaDriver, resolveOllamaUrl } from './ollama';
import { collect, makeAgent, makeRunInput } from './test-support';

let server: Server | undefined;

async function startMockOllama(): Promise<{ url: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          model: 'qwen',
          message: { role: 'assistant', content: '{"ok":true}' },
          prompt_eval_count: 5,
          eval_count: 3,
          done: true,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, bodies };
}

afterEach(async () => {
  const running = server;
  server = undefined;
  await new Promise<void>((resolve) => (running ? running.close(() => resolve()) : resolve()));
});

const ollamaAgent = makeAgent({ runtime: 'ollama', mode: 'api', model: 'qwen', isLocalOnly: true });

describe('resolveOllamaUrl', () => {
  it('reads the ollama.url setting shared with Rust, without a trailing slash', async () => {
    const settings: Record<string, string> = { 'ollama.url': 'http://gpu-box:11434/' };
    expect(await resolveOllamaUrl((key) => Promise.resolve(settings[key] ?? null))).toBe(
      'http://gpu-box:11434',
    );
  });

  it('defaults to the local Ollama', async () => {
    expect(await resolveOllamaUrl(() => Promise.resolve(null))).toBe('http://127.0.0.1:11434');
  });
});

describe('OllamaDriver', () => {
  it('sends format json to /api/chat when jsonOutput is requested', async () => {
    const { url, bodies } = await startMockOllama();
    const driver = new OllamaDriver({ getSetting: () => Promise.resolve(url) });

    const events = await collect(driver.run(makeRunInput({ agent: ollamaAgent, jsonOutput: true })));

    expect(bodies[0]).toMatchObject({ model: 'qwen', format: 'json', stream: false });
    expect(events.map((event) => event.type)).toEqual(['start', 'message', 'usage', 'end']);
    expect(events.at(-1)).toMatchObject({ type: 'end', resultText: '{"ok":true}', isError: false });
  });

  it('omits format when JSON output is not requested', async () => {
    const { url, bodies } = await startMockOllama();
    const driver = new OllamaDriver({ getSetting: () => Promise.resolve(url) });

    await collect(driver.run(makeRunInput({ agent: ollamaAgent, systemPrompt: 'sys' })));

    expect(bodies[0]).not.toHaveProperty('format');
    expect((bodies[0]?.messages as { role: string }[]).map((message) => message.role)).toEqual([
      'system',
      'user',
    ]);
  });

  it('reports an unreachable server as unavailable', async () => {
    const driver = new OllamaDriver({ getSetting: () => Promise.resolve('http://127.0.0.1:1') });

    await expect(collect(driver.run(makeRunInput({ agent: ollamaAgent })))).rejects.toBeInstanceOf(
      DriverUnavailableError,
    );
    const result = await driver.test(ollamaAgent);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('injoignable');
  });
});
