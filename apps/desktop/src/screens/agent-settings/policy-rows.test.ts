import { describe, expect, it } from 'vitest';
import type { ToolPolicy } from '@regis/shared';
import { buildPolicyRows, policyToSave } from './policy-rows';

const policies: ToolPolicy[] = [
  { id: '1', agentId: null, toolPattern: 'mcp__m365__*send*', policy: 'ask' },
  { id: '2', agentId: null, toolPattern: 'mcp__filesystem__write*', policy: 'ask' },
  { id: '3', agentId: 'a1', toolPattern: 'mcp__m365__*send*', policy: 'deny' },
  { id: '4', agentId: 'a2', toolPattern: 'mcp__odoo__*', policy: 'auto' },
];

describe('policy rows', () => {
  it('shows the default rules in the default scope', () => {
    expect(buildPolicyRows(policies, { kind: 'default' })).toEqual([
      { pattern: 'mcp__filesystem__write*', policy: 'ask', inherited: true },
      { pattern: 'mcp__m365__*send*', policy: 'ask', inherited: true },
    ]);
  });

  it('applies the overrides of the selected agent only and marks the rest as inherited', () => {
    expect(buildPolicyRows(policies, { kind: 'agent', agentId: 'a1' })).toEqual([
      { pattern: 'mcp__filesystem__write*', policy: 'ask', inherited: true },
      { pattern: 'mcp__m365__*send*', policy: 'deny', inherited: false },
    ]);
  });

  it('builds the policy to save for the scope', () => {
    expect(policyToSave({ kind: 'agent', agentId: 'a1' }, ' mcp__x__* ', 'auto')).toEqual({
      id: '',
      agentId: 'a1',
      toolPattern: 'mcp__x__*',
      policy: 'auto',
    });
    expect(policyToSave({ kind: 'default' }, 'p', 'deny').agentId).toBeNull();
  });
});
