import { describe, expect, it } from 'vitest';
import { approvalFollowUpMessage } from './approval-follow-up';

const BASE = { approvalId: 'ap1', jobId: 'j1', tool: 'mcp__x__send' };

describe('approvalFollowUpMessage', () => {
  it('tells the agent the action was executed with its result', () => {
    const message = approvalFollowUpMessage({ ...BASE, status: 'approved', ok: true, result: { id: 7 } });

    expect(message).toContain('mcp__x__send');
    expect(message).toContain('exécutée');
    expect(message).toContain('{"id":7}');
  });

  it('reports a failed execution and a rejection with its note', () => {
    const failed = approvalFollowUpMessage({ ...BASE, status: 'approved', ok: false, result: 'boom' });
    const rejected = approvalFollowUpMessage({ ...BASE, status: 'rejected', ok: false, note: 'trop tôt' });

    expect(failed).toContain('a échoué : boom');
    expect(rejected).toContain('rejeté');
    expect(rejected).toContain('trop tôt');
  });

  it('truncates very large results', () => {
    const message = approvalFollowUpMessage({
      ...BASE,
      status: 'approved',
      ok: true,
      result: 'x'.repeat(5000),
    });

    expect(message.length).toBeLessThan(2300);
  });
});
