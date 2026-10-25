import { describe, expect, it } from 'vitest';
import type { Job, JobEvent } from '@regis/shared';
import { chatHistory } from './chat-history';

const JOB = { id: 'j1', prompt: 'Bonjour' } as Job;

function message(id: number, payloadJson: unknown, type: JobEvent['type'] = 'message'): JobEvent {
  return { id, jobId: 'j1', seq: id, at: '2026-10-25T10:00:00Z', type, summary: `résumé ${id}`, payloadJson };
}

describe('chatHistory', () => {
  it('starts with the prompt and keeps user and assistant messages in order', () => {
    const events = [
      message(1, {}, 'start'),
      message(2, { role: 'assistant', text: 'Salut' }),
      message(3, { role: 'user', text: 'Et ensuite ?' }),
      message(4, { role: 'assistant', text: 'Voilà' }),
    ];
    expect(chatHistory(JOB, events, 'Nouvelle question')).toEqual([
      { role: 'user', text: 'Bonjour' },
      { role: 'assistant', text: 'Salut' },
      { role: 'user', text: 'Et ensuite ?' },
      { role: 'assistant', text: 'Voilà' },
    ]);
  });

  it('leaves out the message being sent and merges consecutive turns of the same role', () => {
    const events = [
      message(1, { role: 'assistant', text: 'Je regarde' }),
      message(2, { role: 'assistant', text: 'Terminé' }),
      message(3, { role: 'user', text: 'Merci' }),
    ];
    expect(chatHistory(JOB, events, 'Merci')).toEqual([
      { role: 'user', text: 'Bonjour' },
      { role: 'assistant', text: 'Je regarde\n\nTerminé' },
    ]);
  });

  it('falls back to the summary when a message has no text', () => {
    expect(chatHistory(JOB, [message(1, null)], 'x')).toEqual([
      { role: 'user', text: 'Bonjour' },
      { role: 'assistant', text: 'résumé 1' },
    ]);
  });
});
