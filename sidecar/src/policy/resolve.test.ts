import { describe, expect, it } from 'vitest';
import {
  matchPattern,
  parseDefaultWrite,
  resolvePolicy,
  resolvePolicyMatch,
  type PolicyRule,
} from './resolve';

const SEND_MAIL = 'mcp__m365__send-mail';

describe('matchPattern', () => {
  it('treats only the star as special', () => {
    expect(matchPattern('mcp__m365__*send*', SEND_MAIL)).toBe(true);
    expect(matchPattern('mcp__m365__send-mail', SEND_MAIL)).toBe(true);
    expect(matchPattern('mcp__m365__send.mail', SEND_MAIL)).toBe(false);
    expect(matchPattern('mcp__m365__send', SEND_MAIL)).toBe(false);
    expect(matchPattern('mcp__odoo__*', SEND_MAIL)).toBe(false);
  });
});

describe('resolvePolicy', () => {
  const rules: PolicyRule[] = [
    { agentId: null, toolPattern: 'mcp__m365__*send*', policy: 'ask' },
    { agentId: 'a1', toolPattern: SEND_MAIL, policy: 'deny' },
  ];

  it('lets an agent rule override the default rule for that agent only', () => {
    expect(resolvePolicy(rules, 'a1', SEND_MAIL, 'write')).toBe('deny');
    expect(resolvePolicy(rules, 'a2', SEND_MAIL, 'write')).toBe('ask');
  });

  it('falls back to auto for reads and ask for writes', () => {
    expect(resolvePolicy([], 'a1', 'mcp__x__get', 'read')).toBe('auto');
    expect(resolvePolicy([], 'a1', 'mcp__x__put', 'write')).toBe('ask');
  });

  it('prefers the most specific pattern within a group', () => {
    const specific: PolicyRule[] = [
      { agentId: null, toolPattern: 'mcp__filesystem__*', policy: 'deny' },
      { agentId: null, toolPattern: 'mcp__filesystem__read*', policy: 'auto' },
    ];

    expect(resolvePolicy(specific, 'a1', 'mcp__filesystem__read_file', 'read')).toBe('auto');
    expect(resolvePolicy(specific, 'a1', 'mcp__filesystem__write_file', 'write')).toBe('deny');
  });

  it('breaks ties with deny over ask over auto', () => {
    const tied: PolicyRule[] = [
      { agentId: null, toolPattern: 'mcp__a__x*', policy: 'auto' },
      { agentId: null, toolPattern: 'mcp__a__*x', policy: 'ask' },
    ];
    const withDeny: PolicyRule[] = [...tied, { agentId: null, toolPattern: 'mcp__a__x*x', policy: 'deny' }];

    expect(resolvePolicy(tied, 'a1', 'mcp__a__xx', 'read')).toBe('ask');
    expect(resolvePolicy(withDeny, 'a1', 'mcp__a__xx', 'read')).toBe('deny');
  });

  it('reports the matched pattern', () => {
    expect(resolvePolicyMatch(rules, 'a2', SEND_MAIL, 'write')).toEqual({
      policy: 'ask',
      matchedPattern: 'mcp__m365__*send*',
    });
    expect(resolvePolicyMatch([], 'a2', SEND_MAIL, 'write').matchedPattern).toBeNull();
  });
});

describe('defaultWrite', () => {
  it('replaces the write fallback only', () => {
    expect(resolvePolicy([], 'a1', 'mcp__x__put', 'write')).toBe('ask');
    expect(resolvePolicy([], 'a1', 'mcp__x__put', 'write', 'deny')).toBe('deny');
    expect(resolvePolicy([], 'a1', 'mcp__x__get', 'read', 'deny')).toBe('auto');
  });

  it('keeps explicit rules ahead of the default', () => {
    const rules: PolicyRule[] = [{ agentId: null, toolPattern: 'mcp__x__put', policy: 'auto' }];
    expect(resolvePolicy(rules, 'a1', 'mcp__x__put', 'write', 'deny')).toBe('auto');
  });

  it('parses only deny, everything else is ask', () => {
    expect(parseDefaultWrite('deny')).toBe('deny');
    expect(parseDefaultWrite('auto')).toBe('ask');
    expect(parseDefaultWrite(null)).toBe('ask');
    expect(parseDefaultWrite(undefined)).toBe('ask');
    expect(parseDefaultWrite('n/importe')).toBe('ask');
  });
});
