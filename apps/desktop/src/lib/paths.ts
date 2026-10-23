/** Liens profonds de l'app, construits uniquement ici. */

export function jobPath(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}`;
}

export function transcriptPath(itemId: string): string {
  return `/transcripts/${encodeURIComponent(itemId)}`;
}

export const BRAIN_ENTITY_PARAM = 'entity';

export function entityPath(entityId: string): string {
  return `/cerveau?${BRAIN_ENTITY_PARAM}=${encodeURIComponent(entityId)}`;
}

export function settingsPath(base: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  return query === '' ? base : `${base}?${query}`;
}
