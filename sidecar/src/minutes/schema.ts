import { z } from 'zod';

export const MinutesDraft = z.object({
  summary: z.string().min(1).max(4000),
  decisions: z.array(z.string().min(1)).max(50),
  actions: z.array(z.object({ task: z.string().min(1), owner: z.string().min(1).nullable() })).max(50),
  openPoints: z.array(z.string().min(1)).max(50),
});
export type MinutesDraft = z.infer<typeof MinutesDraft>;

export class MinutesFormatError extends Error {}

const FENCED_BLOCK = /```(?:json)?\s*([\s\S]*?)```/i;

function candidates(text: string): string[] {
  const found: string[] = [text.trim()];
  const fenced = FENCED_BLOCK.exec(text);
  if (fenced?.[1] !== undefined) {
    found.push(fenced[1].trim());
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    found.push(text.slice(start, end + 1));
  }
  return found;
}

/** Accepte un JSON nu ou dans un bloc ```json ; lève MinutesFormatError sinon. */
export function parseMinutesOutput(text: string): MinutesDraft {
  let raw: unknown;
  let parsedJson = false;
  for (const candidate of candidates(text)) {
    try {
      raw = JSON.parse(candidate);
      parsedJson = true;
      break;
    } catch {
      // essai suivant
    }
  }
  if (!parsedJson) {
    throw new MinutesFormatError('Sortie du PV sans objet JSON lisible');
  }
  const parsed = MinutesDraft.safeParse(raw);
  if (!parsed.success) {
    throw new MinutesFormatError(`Sortie du PV invalide : ${parsed.error.message}`);
  }
  return parsed.data;
}
