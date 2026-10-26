import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Approval, NewApproval, NewJobEvent, ToolInfo } from '@regis/shared';
import {
  ApprovalService,
  DEFERRED_DENY_MESSAGE,
  type ApprovalDecision,
  type DeferredOutcome,
} from './service';

const WRITE_TOOL: ToolInfo = {
  connectorId: 'c1',
  name: 'write_file',
  qualifiedName: 'mcp__filesystem__write_file',
  inputSchema: {},
  access: 'write',
};

interface Harness {
  service: ApprovalService;
  created: NewApproval[];
  jobPatches: { jobId: string; patch: Record<string, unknown> }[];
  events: NewJobEvent[];
  calls: { connectorId: string; tool: string; args: unknown }[];
  settled: DeferredOutcome[];
}

function harness(waitTimeoutSec: string | null = '10'): Harness {
  const created: NewApproval[] = [];
  const jobPatches: Harness['jobPatches'] = [];
  const events: NewJobEvent[] = [];
  const calls: Harness['calls'] = [];
  const settled: DeferredOutcome[] = [];
  const service = new ApprovalService({
    store: {
      createApproval: (approval) => {
        created.push(approval);
        return Promise.resolve({
          id: `ap${String(created.length)}`,
          status: 'pending',
          ...approval,
        } as Approval);
      },
      updateJob: (jobId, patch) => {
        jobPatches.push({ jobId, patch });
        return Promise.resolve();
      },
      appendJobEvent: (event) => {
        events.push(event);
        return Promise.resolve();
      },
      getSetting: () => Promise.resolve(waitTimeoutSec),
    },
    tools: {
      findTool: (name) => (name === WRITE_TOOL.qualifiedName ? WRITE_TOOL : undefined),
      callTool: (connectorId, tool, args) => {
        calls.push({ connectorId, tool, args });
        return Promise.resolve({ content: [] });
      },
    },
    onLog: () => undefined,
    onDeferredSettled: (outcome) => settled.push(outcome),
  });
  return { service, created, jobPatches, events, calls, settled };
}

describe('ApprovalService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the decision made before the timeout and records a pending row first', async () => {
    const { service, created } = harness();

    const outcome = service.request('j1', WRITE_TOOL.qualifiedName, { path: 'a' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ jobId: 'j1', tool: WRITE_TOOL.qualifiedName });
    await service.resolve('ap1', { status: 'approved' });

    await expect(outcome).resolves.toEqual({ status: 'approved' });
  });

  it('defers after waitTimeoutSec, parks the job, then executes on a late approval', async () => {
    const { service, jobPatches, calls } = harness('10');

    const outcome = service.request('j1', WRITE_TOOL.qualifiedName, { path: 'a' });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toBe('deferred');
    expect(DEFERRED_DENY_MESSAGE).toContain('Ne pas réessayer');
    expect(jobPatches).toEqual([{ jobId: 'j1', patch: { status: 'waiting_approval' } }]);
    expect(calls).toEqual([]);

    await service.resolve('ap1', { status: 'approved' });

    expect(calls).toEqual([{ connectorId: 'c1', tool: 'write_file', args: { path: 'a' } }]);
  });

  it('hands late answers to a question back without running any tool', async () => {
    const { service, calls, settled } = harness('10');
    const questions = { questions: [{ question: 'Couleur ?', header: 'Couleur', options: [] }] };

    const outcome = service.request('j1', 'AskUserQuestion', questions);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(outcome).resolves.toBe('deferred');
    await service.resolve('ap1', {
      status: 'edited',
      updatedInput: { ...questions, answers: { 'Couleur ?': ['Rouge', 'Bleu'] } },
    });

    expect(calls).toEqual([]);
    expect(settled).toEqual([
      {
        approvalId: 'ap1',
        jobId: 'j1',
        tool: 'AskUserQuestion',
        status: 'edited',
        ok: true,
        result: '« Couleur ? » = « Rouge, Bleu »',
      },
    ]);
  });

  it('reports the outcome of a deferred approval so the job can be resumed', async () => {
    const { service, settled } = harness('1');
    const approved = service.request('j1', WRITE_TOOL.qualifiedName, { path: 'a' });
    const rejected = service.request('j2', WRITE_TOOL.qualifiedName, { path: 'b' });
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([approved, rejected]);

    await service.resolve('ap1', { status: 'approved' });
    await service.resolve('ap2', { status: 'rejected', note: 'non' });

    expect(settled).toEqual([
      {
        approvalId: 'ap1',
        jobId: 'j1',
        tool: WRITE_TOOL.qualifiedName,
        status: 'approved',
        ok: true,
        result: { content: [] },
      },
      {
        approvalId: 'ap2',
        jobId: 'j2',
        tool: WRITE_TOOL.qualifiedName,
        status: 'rejected',
        ok: false,
        note: 'non',
      },
    ]);
  });

  it('does not report approvals resolved before the timeout', async () => {
    const { service, settled } = harness();
    const outcome = service.request('j1', WRITE_TOOL.qualifiedName, {});
    await vi.advanceTimersByTimeAsync(10);
    await service.resolve('ap1', { status: 'approved' });
    await outcome;

    expect(settled).toEqual([]);
  });

  it('executes the deferred call with the edited input when one is provided', async () => {
    const { service, calls } = harness('1');
    const outcome = service.request('j1', WRITE_TOOL.qualifiedName, { path: 'a' });
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;

    await service.resolve('ap1', { status: 'edited', updatedInput: { path: 'b' } });

    expect(calls).toEqual([{ connectorId: 'c1', tool: 'write_file', args: { path: 'b' } }]);
  });

  it('does not execute a rejected deferred approval', async () => {
    const { service, calls } = harness('1');
    const outcome = service.request('j1', WRITE_TOOL.qualifiedName, {});
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;

    await service.resolve('ap1', { status: 'rejected', note: 'non' });

    expect(calls).toEqual([]);
  });

  it('refuses to resolve the same approval twice and never runs the tool twice', async () => {
    const { service, calls } = harness('1');
    const outcome = service.request('j1', WRITE_TOOL.qualifiedName, {});
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
    const approve: ApprovalDecision = { status: 'approved' };

    await Promise.all([
      service.resolve('ap1', approve),
      expect(service.resolve('ap1', approve)).rejects.toThrow(),
    ]);
    await expect(service.resolve('ap1', approve)).rejects.toThrow();

    expect(calls).toHaveLength(1);
  });

  it('falls back to 600 seconds when the setting is missing', async () => {
    const { service } = harness(null);
    let settled = false;
    void service.request('j1', WRITE_TOOL.qualifiedName, {}).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(599_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
  });
});
