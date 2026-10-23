import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const claudeCliDirectory = join(root, 'tests', 'fixtures', 'claude-cli');
const ndjsonFixtures = [
  'simple',
  'tool-use',
  'permission-allow',
  'permission-allow-updated',
  'permission-deny',
];

function readNdjson(name: string): Record<string, unknown>[] {
  return readFileSync(join(claudeCliDirectory, `${name}.ndjson`), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
}

describe('claude-cli ndjson fixtures', () => {
  it.each(ndjsonFixtures)('%s starts with a real _meta line and holds valid JSON lines', (name) => {
    const [first, ...events] = readNdjson(name);
    expect(first?._meta).toMatchObject({ source: 'claude-cli', synthetic: false });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(typeof event.type).toBe('string');
    }
  });

  it('simple starts with system/init and ends with result', () => {
    const events = readNdjson('simple').slice(1);
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(events.at(-1)?.type).toBe('result');
  });
});

describe('permission-allow-updated.ndjson', () => {
  it('shows the edited input being executed and no permission denial', () => {
    const events = readNdjson('permission-allow-updated').slice(1);
    const text = JSON.stringify(events);
    expect(text).toContain('Successfully wrote to <WORKSPACE>/edited.txt');
    expect(text).not.toContain('Successfully wrote to <WORKSPACE>/out.txt');
    expect(events.at(-1)).toMatchObject({ type: 'result', is_error: false, permission_denials: [] });
  });
});

describe('permission-prompt.json', () => {
  it('holds the request and both responses', () => {
    const fixture = readJson('tests/fixtures/claude-cli/permission-prompt.json');
    expect(fixture).toHaveProperty('request');
    expect(fixture).toHaveProperty('allowResponse');
    expect(fixture).toHaveProperty('denyResponse');
  });
});

describe('mcp tools fixtures', () => {
  it.each(['filesystem', 'ms365'])('%s lists tools with a name and an inputSchema', (name) => {
    const fixture = readJson(`tests/fixtures/mcp/${name}.tools.json`);
    const tools = fixture.tools as Record<string, unknown>[];
    expect(fixture._meta).toMatchObject({ source: 'mcp' });
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool).toHaveProperty('inputSchema');
    }
  });
});

describe('fake claude binary', () => {
  const fakeClaude = join(root, 'tests', 'fake-bins', 'claude');

  function replay(fixture: string, extraEnv: Record<string, string> = {}): string {
    return execFileSync(process.execPath, [fakeClaude, '-p', 'x'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FAKE_CLAUDE_FIXTURE: fixture, ...extraEnv },
    });
  }

  it('replays the fixture lines without the _meta line', () => {
    const fixture = 'tests/fixtures/claude-cli/simple.ndjson';
    const expected = readFileSync(join(root, fixture), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .slice(1)
      .map((line) => `${line}\n`)
      .join('');
    expect(replay(fixture)).toBe(expected);
  });

  it('exits with FAKE_CLAUDE_EXIT', () => {
    expect(() => replay('tests/fixtures/claude-cli/simple.ndjson', { FAKE_CLAUDE_EXIT: '3' })).toThrow(
      expect.objectContaining({ status: 3 }) as Error,
    );
  });
});
