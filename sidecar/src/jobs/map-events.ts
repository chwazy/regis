import type { JobEvent } from '@regis/shared';
import type { AgentEvent } from '../agents/driver';

const MAX_SUMMARY_LENGTH = 200;

export function toJobEvent(jobId: string, event: AgentEvent): Omit<JobEvent, 'id' | 'seq'> | null {
  const at = new Date().toISOString();
  switch (event.type) {
    case 'usage':
      return null;
    case 'start':
      return {
        jobId,
        at,
        type: 'start',
        summary: event.model ? `Démarrage (${event.model})` : 'Démarrage',
        payloadJson: { sessionId: event.sessionId ?? null, model: event.model ?? null },
      };
    case 'message':
      return {
        jobId,
        at,
        type: 'message',
        summary: summarize(event.text, 'Message'),
        payloadJson: { role: 'assistant', text: event.text },
      };
    case 'tool_call':
      return {
        jobId,
        at,
        type: 'tool_call',
        summary: summarize(event.tool, 'Appel d’outil'),
        payloadJson: { toolUseId: event.toolUseId, tool: event.tool, input: event.input },
      };
    case 'tool_result':
      return {
        jobId,
        at,
        type: 'tool_result',
        summary: summarize(event.summary, event.ok ? 'Résultat de l’outil' : 'Échec de l’outil'),
        payloadJson: { toolUseId: event.toolUseId, ok: event.ok },
      };
    case 'end':
      return {
        jobId,
        at,
        type: 'end',
        summary: summarize(event.resultText, event.isError ? 'Terminé en erreur' : 'Terminé'),
        payloadJson: {
          resultText: event.resultText,
          isError: event.isError,
          subtype: event.subtype ?? null,
        },
      };
    case 'error':
      return {
        jobId,
        at,
        type: 'error',
        summary: summarize(event.message, 'Erreur'),
        payloadJson: { message: event.message },
      };
  }
}

function summarize(text: string, fallback: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') {
    return fallback;
  }
  return collapsed.length <= MAX_SUMMARY_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}
