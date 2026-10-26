import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLaunchResolver } from '../connectors/launch';
import { ODOO_DEV_ENTRY, buildFromPreset } from '../connectors/presets';
import { resolveClaudeBin } from './claude-bin';
import { ClaudeCliDriver } from './claude-cli';
import { denyWritesPolicy } from './deny-writes-policy';
import { DriverUnavailableError } from './driver';
import { collect, makeAgent, makeRunInput } from './test-support';

const FAKE_BIN = fileURLToPath(new URL('../../../tests/fake-bins/claude', import.meta.url));
const FAKE_SCRIPT = fileURLToPath(new URL('../../../tests/fake-bins/claude.mjs', import.meta.url));
const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../../tests/fixtures/claude-cli/${name}.ndjson`, import.meta.url));

function driverWith(
  resolveBin: () => Promise<string>,
  extraEnv: Record<string, string> = {},
): ClaudeCliDriver {
  return new ClaudeCliDriver({
    resolveBin,
    listConnectors: () => Promise.resolve([]),
    listTools: () => [],
    resolveSecret: () => Promise.resolve(null),
    policy: denyWritesPolicy,
    onLog: () => undefined,
    extraEnv,
  });
}

function fakeDriver(fixture: string, extraEnv: Record<string, string> = {}): ClaudeCliDriver {
  return driverWith(
    () => resolveClaudeBin({ getSetting: () => Promise.resolve(null), env: { REGIS_CLAUDE_BIN: FAKE_BIN } }),
    { FAKE_CLAUDE_FIXTURE: fixturePath(fixture), ...extraEnv },
  );
}

describe('ClaudeCliDriver', () => {
  it('streams the replayed fixture and terminates', async () => {
    const events = await collect(fakeDriver('simple').run(makeRunInput()));

    expect(events.map((event) => event.type)).toEqual(['start', 'message', 'usage', 'end']);
    expect(events.at(-1)).toMatchObject({ type: 'end', isError: false });
  });

  it('replays tool calls from the tool-use fixture', async () => {
    const events = await collect(fakeDriver('tool-use').run(makeRunInput()));

    expect(events.filter((event) => event.type === 'tool_call').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'tool_result').length).toBeGreaterThan(0);
  });

  it('keeps the regis bearer token out of mcp.json and passes it through the child environment', async () => {
    const token = 'regis-token-for-test';
    const dumpDirectory = await mkdtemp(join(tmpdir(), 'regis-dump-'));
    const dumpPath = join(dumpDirectory, 'dump.json');
    try {
      const driver = new ClaudeCliDriver({
        resolveBin: () =>
          resolveClaudeBin({ getSetting: () => Promise.resolve(null), env: { REGIS_CLAUDE_BIN: FAKE_BIN } }),
        listConnectors: () => Promise.resolve([]),
        listTools: () => [],
        resolveSecret: () => Promise.resolve(null),
        policy: { ...denyWritesPolicy, permissionTool: 'mcp__regis__approve' },
        regisEndpoint: () => Promise.resolve({ url: 'http://127.0.0.1:1/mcp', token }),
        onLog: () => undefined,
        extraEnv: { FAKE_CLAUDE_FIXTURE: fixturePath('simple'), FAKE_CLAUDE_DUMP: dumpPath },
      });

      await collect(driver.run(makeRunInput()));

      const dump = JSON.parse(await readFile(dumpPath, 'utf8')) as {
        mcpConfig: string;
        env: Record<string, string>;
      };
      expect(dump.mcpConfig).not.toContain(token);
      const config = JSON.parse(dump.mcpConfig) as {
        mcpServers: { regis: { headers: Record<string, string> } };
      };
      expect(config.mcpServers.regis.headers.Authorization).toBe('Bearer ${REGIS_MCP_SECRET_REGIS_INTERNAL}');
      expect(dump.env.REGIS_MCP_SECRET_REGIS_INTERNAL).toBe(token);
    } finally {
      await rm(dumpDirectory, { recursive: true, force: true });
    }
  });

  it('runs a node script binary with node so multi-line arguments survive', async () => {
    const dumpDirectory = await mkdtemp(join(tmpdir(), 'regis-dump-'));
    const dumpPath = join(dumpDirectory, 'dump.json');
    try {
      const driver = driverWith(
        () =>
          resolveClaudeBin({
            getSetting: () => Promise.resolve(null),
            env: { REGIS_CLAUDE_BIN: FAKE_SCRIPT },
          }),
        { FAKE_CLAUDE_FIXTURE: fixturePath('simple'), FAKE_CLAUDE_DUMP: dumpPath },
      );

      await collect(
        driver.run(makeRunInput({ systemPrompt: 'Ligne 1\nLigne 2', agent: makeAgent({ model: 'haiku' }) })),
      );

      const { args } = JSON.parse(await readFile(dumpPath, 'utf8')) as { args: string[] };
      expect(args).toContain('Ligne 1\nLigne 2');
      expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'haiku']);
    } finally {
      await rm(dumpDirectory, { recursive: true, force: true });
    }
  });

  it('writes the launch-time resolved odoo command into mcp.json', async () => {
    const dumpDirectory = await mkdtemp(join(tmpdir(), 'regis-dump-'));
    const dumpPath = join(dumpDirectory, 'dump.json');
    try {
      const driver = new ClaudeCliDriver({
        resolveBin: () =>
          resolveClaudeBin({ getSetting: () => Promise.resolve(null), env: { REGIS_CLAUDE_BIN: FAKE_BIN } }),
        listConnectors: () => Promise.resolve([{ ...buildFromPreset('odoo'), id: 'odoo-1' }]),
        listTools: () => [],
        resolveSecret: () => Promise.resolve(null),
        resolveLaunch: createLaunchResolver(() => Promise.resolve('Pacific/Auckland'), {}),
        policy: denyWritesPolicy,
        onLog: () => undefined,
        extraEnv: { FAKE_CLAUDE_FIXTURE: fixturePath('simple'), FAKE_CLAUDE_DUMP: dumpPath },
      });

      await collect(driver.run(makeRunInput({ agent: makeAgent({ connectorIdsJson: ['odoo-1'] }) })));

      const dump = JSON.parse(await readFile(dumpPath, 'utf8')) as { mcpConfig: string };
      const config = JSON.parse(dump.mcpConfig) as { mcpServers: Record<string, unknown> };
      expect(Object.values(config.mcpServers)).toContainEqual(
        expect.objectContaining({
          command: 'node',
          args: [ODOO_DEV_ENTRY],
          env: expect.objectContaining({ REGIS_TIMEZONE: 'Pacific/Auckland' }) as unknown,
        }),
      );
    } finally {
      await rm(dumpDirectory, { recursive: true, force: true });
    }
  });

  it('replays the allow-with-updatedInput fixture to a clean end', async () => {
    const events = await collect(fakeDriver('permission-allow-updated').run(makeRunInput()));

    expect(events.at(-1)).toMatchObject({ type: 'end', isError: false });
  });

  it('kills the process within 2 seconds when aborted mid-stream', async () => {
    const controller = new AbortController();
    const driver = fakeDriver('tool-use', { FAKE_CLAUDE_DELAY_MS: '10000' });
    let abortedAt = 0;

    for await (const event of driver.run(makeRunInput({ signal: controller.signal }))) {
      if (event.type === 'start') {
        abortedAt = Date.now();
        controller.abort();
      }
    }

    expect(abortedAt).toBeGreaterThan(0);
    expect(Date.now() - abortedAt).toBeLessThan(2000);
  });

  it('turns a successful replay into an OK test result', async () => {
    const result = await fakeDriver('simple').test(makeAgent());

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('raises a readable DriverUnavailableError for an invalid claudeBin', async () => {
    const driver = driverWith(() =>
      resolveClaudeBin({
        getSetting: (key) => Promise.resolve(key === 'agents.claudeBin' ? 'definitely-not-claude-bin' : null),
        env: {},
      }),
    );

    await expect(collect(driver.run(makeRunInput()))).rejects.toBeInstanceOf(DriverUnavailableError);
    const result = await driver.test(makeAgent());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('introuvable');
  });
});
