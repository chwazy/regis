export interface MinutesContext {
  transcriptItemId: string;
  title: string;
  transcript: string; // body_text du transcript
  startedAt: string;
  durationMs: number | null; // depuis recordings
  attendees: { name: string | null; address: string }[]; // depuis l'événement, [] sinon
  entityIds: string[];
}

export const DEFAULT_MAX_TRANSCRIPT_CHARS = 60_000;

export interface MinutesPromptOptions {
  maxTranscriptChars?: number;
  retryReason?: string;
}

const HALF = 2;

export function truncateTranscript(
  transcript: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (transcript.length <= maxChars) {
    return { text: transcript, truncated: false };
  }
  const head = Math.ceil(maxChars / HALF);
  const tail = maxChars - head;
  return {
    text: `${transcript.slice(0, head)}\n[…]\n${tail > 0 ? transcript.slice(-tail) : ''}`,
    truncated: true,
  };
}

export function buildMinutesPrompt(ctx: MinutesContext, options: MinutesPromptOptions = {}): string {
  const { text, truncated } = truncateTranscript(
    ctx.transcript,
    options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS,
  );
  return [
    'You write the minutes (procès-verbal) of a meeting from its transcript. Answer in French.',
    'Use ONLY the transcript below. Never invent a decision, an action, an owner or a fact that is not in it.',
    'Do not write any date, time, duration, amount or count of your own: they are added separately from the data.',
    'Reply with a single JSON object and nothing else, with exactly this shape:',
    '{"summary": string (a short paragraph), "decisions": [string], "actions": [{"task": string, "owner": string | null}], "openPoints": [string]}',
    'Use "owner": null when nobody is named for an action. Use empty arrays when a section has nothing to report.',
    ...(truncated
      ? [
          'The transcript was too long: only its beginning and its end are given, separated by "[…]". Say nothing about the missing middle part.',
        ]
      : []),
    ...(options.retryReason
      ? [`Your previous answer was rejected (${options.retryReason}). Reply with valid JSON only.`]
      : []),
    `Meeting: ${ctx.title}`,
    'Transcript:',
    text,
  ].join('\n');
}
