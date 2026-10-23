import { describe, expect, it } from 'vitest';
import type { Job, JobStatus } from './index';

describe('generated types', () => {
  it('exposes the job types generated from Rust', () => {
    const status: JobStatus = 'waiting_approval';
    const job: Job = {
      id: '01J0000000000000000000000',
      parentId: null,
      agentId: 'agent',
      kind: 'task',
      title: 'Write report',
      prompt: 'Write the report',
      status,
      sessionId: null,
      cwd: null,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      routingReason: null,
      resultText: null,
      error: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: null,
      endedAt: null,
    };
    expect(job.status).toBe('waiting_approval');
  });
});
