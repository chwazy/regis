import { describe, expect, it } from 'vitest';
import type { ToolInfo } from '@regis/shared';
import { makeAgent } from '../agents/test-support';
import { buildToolFlags } from './flags';
import type { PolicyRule } from './resolve';

function tool(name: string, access: ToolInfo['access']): ToolInfo {
  return { connectorId: 'c1', name, qualifiedName: `mcp__srv__${name}`, inputSchema: {}, access };
}

describe('buildToolFlags', () => {
  const tools = [
    tool('get_a', 'read'),
    tool('put_b', 'write'),
    tool('drop_c', 'write'),
    tool('send_d', 'write'),
  ];
  const rules: PolicyRule[] = [
    { agentId: null, toolPattern: 'mcp__srv__drop*', policy: 'deny' },
    { agentId: null, toolPattern: 'mcp__srv__send*', policy: 'auto' },
  ];

  it('lists auto tools as allowed, deny tools as disallowed and leaves ask tools out', () => {
    const flags = buildToolFlags(rules, makeAgent(), tools);

    expect(flags.allowed).toEqual(['mcp__srv__get_a', 'mcp__srv__send_d']);
    expect(flags.disallowed).toEqual(['mcp__srv__drop_c']);
    expect([...flags.allowed, ...flags.disallowed]).not.toContain('mcp__srv__put_b');
  });
});
