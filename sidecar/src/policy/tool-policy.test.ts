import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Approval, ToolInfo } from '@regis/shared';
import { createApprove } from '../regis-mcp/approve';
import { ApprovalService, DEFERRED_DENY_MESSAGE } from '../approvals/service';
import { makeAgent } from '../agents/test-support';
import {
  REGIS_BRAIN_ADD_FACT_TOOL,
  REGIS_BRAIN_READ_TOOLS,
  REGIS_BRAIN_WRITE_TOOLS,
} from '../regis-mcp/brain-tools';
import { REGIS_JOB_TOOLS } from '../regis-mcp/jobs-tools';
import { REGIS_RENDER_TEMPLATE_TOOL } from '../regis-mcp/template-tools';
import type { PolicyRule } from './resolve';
import { createToolPolicy } from './tool-policy';

const WRITE_TOOL: ToolInfo = {
  connectorId: 'c1',
  name: 'write_file',
  qualifiedName: 'mcp__filesystem__write_file',
  inputSchema: {},
  access: 'write',
};

const WAIT_TIMEOUT_SEC = 10;

function approveWithTimeout(): ReturnType<typeof createApprove> {
  const service = new ApprovalService({
    store: {
      createApproval: (approval) =>
        Promise.resolve({ id: 'ap1', status: 'pending', ...approval } as Approval),
      updateJob: () => Promise.resolve(),
      appendJobEvent: () => Promise.resolve(),
      getSetting: () => Promise.resolve(String(WAIT_TIMEOUT_SEC)),
    },
    tools: { findTool: () => WRITE_TOOL, callTool: () => Promise.resolve({}) },
    onLog: () => undefined,
  });
  const policy = createToolPolicy({ listRules: () => Promise.resolve([]), approvals: service });
  return createApprove({
    authorize: (context, toolName, input) =>
      policy.authorize({
        agentId: context.agentId,
        jobId: context.jobId,
        qualifiedName: toolName,
        access: 'write',
        input,
      }),
  });
}

describe('tool policy approval timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replies a deny carrying DEFERRED_DENY_MESSAGE once waitTimeoutSec has elapsed', async () => {
    const approve = approveWithTimeout();

    const reply = approve(
      { jobId: 'j1', agentId: 'a1' },
      { tool_name: WRITE_TOOL.qualifiedName, input: { path: 'a', content: 'b' } },
    );
    await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_SEC * 1000);

    await expect(reply).resolves.toEqual({ behavior: 'deny', message: DEFERRED_DENY_MESSAGE });
  });
});

const flagsPolicy = createToolPolicy({
  listRules: () => Promise.resolve([]),
  approvals: { request: () => Promise.resolve('deferred') },
});

const policyWithRules = (rules: PolicyRule[]) =>
  createToolPolicy({
    listRules: () => Promise.resolve(rules),
    approvals: { request: () => Promise.resolve('deferred') },
  });

describe('createToolPolicy buildToolFlags', () => {
  it('allows the regis job tools only for agents that can spawn', async () => {
    const spawner = await flagsPolicy.buildToolFlags(makeAgent({ canSpawn: true }), []);
    const worker = await flagsPolicy.buildToolFlags(makeAgent({ canSpawn: false }), []);

    expect(spawner.allowed).toEqual([...REGIS_JOB_TOOLS, ...REGIS_BRAIN_READ_TOOLS]);
    expect(worker.allowed).toEqual(REGIS_BRAIN_READ_TOOLS);
    expect(worker.disallowed).toContain('Bash');
  });

  it('keeps brain_add_fact behind a prompt until a rule makes it automatic', async () => {
    const unruled = await flagsPolicy.buildToolFlags(makeAgent(), []);
    const automatic = await policyWithRules([
      { agentId: null, toolPattern: REGIS_BRAIN_ADD_FACT_TOOL, policy: 'auto' },
    ]).buildToolFlags(makeAgent(), []);
    const denied = await policyWithRules([
      { agentId: null, toolPattern: REGIS_BRAIN_ADD_FACT_TOOL, policy: 'deny' },
    ]).buildToolFlags(makeAgent(), []);

    expect(unruled.allowed).not.toContain(REGIS_BRAIN_ADD_FACT_TOOL);
    expect(automatic.allowed).toContain(REGIS_BRAIN_ADD_FACT_TOOL);
    expect(denied.disallowed).toContain(REGIS_BRAIN_ADD_FACT_TOOL);
  });

  it('lets an agent rule open every brain write tool while the default keeps asking', async () => {
    const rules: PolicyRule[] = [
      { agentId: null, toolPattern: 'mcp__regis__brain_*', policy: 'ask' },
      { agentId: 'writer', toolPattern: 'mcp__regis__brain_*', policy: 'auto' },
      { agentId: 'reader', toolPattern: 'mcp__regis__brain_*', policy: 'deny' },
    ];

    const writer = await policyWithRules(rules).buildToolFlags(makeAgent({ id: 'writer' }), []);
    const reader = await policyWithRules(rules).buildToolFlags(makeAgent({ id: 'reader' }), []);
    const other = await policyWithRules(rules).buildToolFlags(makeAgent({ id: 'other' }), []);

    expect(writer.allowed).toEqual(expect.arrayContaining(REGIS_BRAIN_WRITE_TOOLS));
    expect(reader.disallowed).toEqual(expect.arrayContaining(REGIS_BRAIN_WRITE_TOOLS));
    expect(reader.allowed).toEqual(expect.arrayContaining(REGIS_BRAIN_READ_TOOLS));
    for (const tool of REGIS_BRAIN_WRITE_TOOLS) {
      expect(other.allowed).not.toContain(tool);
      expect(other.disallowed).not.toContain(tool);
    }
  });

  it('allows render_template only when a rule makes it automatic', async () => {
    const unruled = await flagsPolicy.buildToolFlags(makeAgent(), []);
    const automatic = await policyWithRules([
      { agentId: null, toolPattern: REGIS_RENDER_TEMPLATE_TOOL, policy: 'auto' },
    ]).buildToolFlags(makeAgent(), []);
    const denied = await policyWithRules([
      { agentId: null, toolPattern: REGIS_RENDER_TEMPLATE_TOOL, policy: 'deny' },
    ]).buildToolFlags(makeAgent(), []);

    expect(unruled.allowed).not.toContain(REGIS_RENDER_TEMPLATE_TOOL);
    expect(automatic.allowed).toContain(REGIS_RENDER_TEMPLATE_TOOL);
    expect(denied.disallowed).toContain(REGIS_RENDER_TEMPLATE_TOOL);
  });
});
