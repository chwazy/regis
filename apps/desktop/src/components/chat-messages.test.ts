import { describe, expect, it } from 'vitest';
import type { Job, JobEvent } from '@regis/shared';
import { buildChatMessages, buildChatTimeline, chatSubJobs } from './chat-messages';

const CHAT = { id: 'c1', prompt: 'Bonjour', parentId: null, createdAt: '2026-01-01T00:00:00Z' } as Job;

function message(id: number, payloadJson: unknown, type: JobEvent['type'] = 'message'): JobEvent {
  return {
    id,
    jobId: 'c1',
    seq: id,
    at: `2026-01-01T00:00:0${String(id)}Z`,
    type,
    summary: `résumé ${String(id)}`,
    payloadJson,
  };
}

describe('chat messages', () => {
  it('starts with the prompt, then user and assistant messages in order, ignoring other events', () => {
    const messages = buildChatMessages(CHAT, [
      message(1, {}, 'start'),
      message(2, { role: 'assistant', text: 'Salut' }),
      message(3, { role: 'user', text: 'Et ensuite ?' }),
      message(4, null),
    ]);

    expect(messages.map((entry) => [entry.role, entry.text])).toEqual([
      ['user', 'Bonjour'],
      ['assistant', 'Salut'],
      ['user', 'Et ensuite ?'],
      ['assistant', 'résumé 4'],
    ]);
  });

  it('lists the direct sub-jobs of the conversation by creation order', () => {
    const jobs = [
      { id: 'b', parentId: 'c1', createdAt: '2' },
      { id: 'a', parentId: 'c1', createdAt: '1' },
      { id: 'x', parentId: 'other', createdAt: '0' },
    ] as Job[];

    expect(chatSubJobs('c1', jobs).map((job) => job.id)).toEqual(['a', 'b']);
  });

  it('interleaves sub-job cards with messages by time', () => {
    const jobs = [{ id: 'sub', parentId: 'c1', createdAt: '2026-01-01T00:00:02.500Z' }] as Job[];

    const timeline = buildChatTimeline(
      CHAT,
      [
        message(2, { role: 'assistant', text: 'Je délègue' }),
        message(3, { role: 'assistant', text: 'Fini' }),
      ],
      jobs,
    );

    expect(timeline.map((item) => item.key)).toEqual(['m-prompt', 'm-2', 'j-sub', 'm-3']);
  });
});
