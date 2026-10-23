import type { Job, JobEvent } from '@regis/shared';

export interface ChatMessage {
  key: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export type ChatItem =
  | { kind: 'message'; key: string; at: string; message: ChatMessage }
  | { kind: 'subjob'; key: string; at: string; job: Job };

export function buildChatMessages(job: Job, events: JobEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ key: 'prompt', role: 'user', text: job.prompt, at: job.createdAt }];
  for (const event of events) {
    if (event.type !== 'message') {
      continue;
    }
    const payload =
      typeof event.payloadJson === 'object' && event.payloadJson !== null
        ? (event.payloadJson as { role?: unknown; text?: unknown })
        : {};
    messages.push({
      key: String(event.id),
      role: payload.role === 'user' ? 'user' : 'assistant',
      text: typeof payload.text === 'string' ? payload.text : event.summary,
      at: event.at,
    });
  }
  return messages;
}

export function chatSubJobs(chatJobId: string, jobs: Job[]): Job[] {
  return jobs
    .filter((job) => job.parentId === chatJobId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function buildChatTimeline(job: Job, events: JobEvent[], jobs: Job[]): ChatItem[] {
  const items: ChatItem[] = [
    ...buildChatMessages(job, events).map((message): ChatItem => ({
      kind: 'message',
      key: `m-${message.key}`,
      at: message.at,
      message,
    })),
    ...chatSubJobs(job.id, jobs).map((subJob): ChatItem => ({
      kind: 'subjob',
      key: `j-${subJob.id}`,
      at: subJob.createdAt,
      job: subJob,
    })),
  ];
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => Date.parse(left.item.at) - Date.parse(right.item.at) || left.index - right.index)
    .map(({ item }) => item);
}
