import { describe, expect, it } from 'vitest';
import type { McpHost } from '../mcp/host';
import { readFixture, toolText } from './fixtures';
import { M365Login, M365LoginError, parseDeviceCode, parseVerifyLogin } from './m365-login';

interface LoginFixture {
  _meta: { synthetic: boolean };
  login: { pending: string; entraError: string };
  verifyLogin: { loggedIn: unknown; loggedOut: unknown };
}

const fixture = readFixture<LoginFixture>('ms365.login.json');
const NOW = new Date('2026-10-22T10:00:00.000Z');

function hostReplying(replies: Record<string, unknown[]>): { host: McpHost; clock: { now: Date } } {
  const queues = new Map(Object.entries(replies).map(([tool, list]) => [tool, [...list]]));
  const host = {
    callTool: (_id: string, tool: string) => {
      const queue = queues.get(tool) ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return Promise.resolve(next);
    },
  } as unknown as McpHost;
  return { host, clock: { now: NOW } };
}

describe('device code parsing', () => {
  it('extracts the uri and the user code', () => {
    expect(parseDeviceCode(fixture.login.pending, NOW)).toEqual({
      verificationUri: 'https://microsoft.com/devicelogin',
      userCode: 'ABCD1234',
      expiresAt: '2026-10-22T10:15:00.000Z',
    });
  });

  it('returns null when the text holds no code', () => {
    expect(parseDeviceCode(fixture.login.entraError, NOW)).toBeNull();
  });
});

describe('verify-login parsing', () => {
  it('reads the account of a logged-in user', () => {
    expect(parseVerifyLogin(JSON.stringify(fixture.verifyLogin.loggedIn))).toMatchObject({
      loggedIn: true,
      account: 'regis.user@example.test',
    });
  });

  it('reports a logged-out user', () => {
    expect(parseVerifyLogin(JSON.stringify(fixture.verifyLogin.loggedOut)).loggedIn).toBe(false);
  });
});

describe('M365Login', () => {
  it('goes from the device code to done once verify-login succeeds', async () => {
    const { host, clock } = hostReplying({
      login: [toolText(fixture.login.pending)],
      'verify-login': [toolText(fixture.verifyLogin.loggedOut), toolText(fixture.verifyLogin.loggedIn)],
    });
    const login = new M365Login(host, () => clock.now);

    const start = await login.begin('c1');
    expect(start.userCode).toBe('ABCD1234');
    expect(await login.status('c1')).toEqual({ state: 'pending' });
    expect(await login.status('c1')).toEqual({ state: 'done', account: 'regis.user@example.test' });
  });

  it('fails once the code has expired', async () => {
    const { host, clock } = hostReplying({
      login: [toolText(fixture.login.pending)],
      'verify-login': [toolText(fixture.verifyLogin.loggedOut)],
    });
    const login = new M365Login(host, () => clock.now);
    await login.begin('c1');

    clock.now = new Date(NOW.getTime() + 16 * 60_000);

    expect(await login.status('c1')).toMatchObject({ state: 'failed' });
  });

  it('shows the Entra error as is', async () => {
    const { host, clock } = hostReplying({
      login: [toolText(fixture.login.pending)],
      'verify-login': [toolText({ success: false, message: fixture.login.entraError })],
    });
    const login = new M365Login(host, () => clock.now);
    await login.begin('c1');

    expect(await login.status('c1')).toEqual({ state: 'failed', error: fixture.login.entraError });
  });

  it('throws the server text when no device code is returned', async () => {
    const { host, clock } = hostReplying({
      login: [toolText(fixture.login.entraError)],
      'verify-login': [toolText(fixture.verifyLogin.loggedOut)],
    });
    const login = new M365Login(host, () => clock.now);

    await expect(login.begin('c1')).rejects.toThrow(M365LoginError);
    await expect(login.begin('c1')).rejects.toThrow('AADSTS65001');
  });
});
