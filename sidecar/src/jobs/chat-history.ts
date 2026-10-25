import type { Job, JobEvent } from '@regis/shared';
import type { ChatTurn } from '../agents/driver';

function messageTurn(event: JobEvent): ChatTurn {
  const payload =
    typeof event.payloadJson === 'object' && event.payloadJson !== null
      ? (event.payloadJson as { role?: unknown; text?: unknown })
      : {};
  return {
    role: payload.role === 'user' ? 'user' : 'assistant',
    text: typeof payload.text === 'string' ? payload.text : event.summary,
  };
}

/** Échanges déjà enregistrés d'un job, sans le message en cours d'envoi, tours consécutifs fusionnés. */
export function chatHistory(job: Job, events: JobEvent[], nextMessage: string): ChatTurn[] {
  const turns: ChatTurn[] = [
    { role: 'user', text: job.prompt },
    ...events.filter((event) => event.type === 'message').map(messageTurn),
  ];
  const last = turns.at(-1);
  if (turns.length > 1 && last?.role === 'user' && last.text === nextMessage) {
    turns.pop();
  }
  return turns.reduce<ChatTurn[]>((merged, turn) => {
    const previous = merged.at(-1);
    if (previous?.role === turn.role) {
      previous.text = `${previous.text}\n\n${turn.text}`;
    } else {
      merged.push({ ...turn });
    }
    return merged;
  }, []);
}
