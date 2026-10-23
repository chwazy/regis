import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agents/driver';
import { toJobEvent } from './map-events';

const LONG = 'x'.repeat(500);

const EVENTS: Record<Exclude<AgentEvent['type'], 'usage'>, AgentEvent> = {
  start: { type: 'start', sessionId: 's1', model: 'haiku' },
  message: { type: 'message', text: 'hello' },
  tool_call: { type: 'tool_call', toolUseId: 't1', tool: 'mcp__x__y', input: { a: 1 } },
  tool_result: { type: 'tool_result', toolUseId: 't1', ok: true, summary: 'done' },
  end: { type: 'end', resultText: 'finished', isError: false },
  error: { type: 'error', message: 'boom' },
};

describe('toJobEvent', () => {
  it.each(Object.entries(EVENTS))('maps %s to the matching job event type', (type, event) => {
    const mapped = toJobEvent('j1', event);

    expect(mapped).not.toBeNull();
    expect(mapped?.type).toBe(type);
    expect(mapped?.jobId).toBe('j1');
    expect(mapped?.summary.length).toBeGreaterThan(0);
    expect(mapped?.summary.length).toBeLessThanOrEqual(200);
  });

  it('returns null for usage, which is aggregated on the job', () => {
    expect(toJobEvent('j1', { type: 'usage', costUsd: 1, tokensIn: 2, tokensOut: 3 })).toBeNull();
  });

  it('keeps the summary non-empty and bounded for empty and very long texts', () => {
    const empty = toJobEvent('j1', { type: 'message', text: '' });
    const empties = toJobEvent('j1', { type: 'end', resultText: '', isError: true });
    const long = toJobEvent('j1', { type: 'message', text: LONG });

    expect(empty?.summary).not.toBe('');
    expect(empties?.summary).not.toBe('');
    expect(long?.summary).toHaveLength(200);
    expect(long?.payloadJson).toMatchObject({ text: LONG });
  });
});
