import type { ChunkNeighbor, Link } from '@regis/shared';

export interface EntitySuggestion {
  entityId: string;
  score: number;
}

export interface SuggestDeps {
  neighbors: (fileId: string) => Promise<ChunkNeighbor[]>;
  listLinks: () => Promise<Link[]>;
}

export const DEFAULT_SUGGESTION_COUNT = 3;
export const SUGGEST_MIN_SCORE = 0.5;

export function scoreFromDistance(distance: number): number {
  return Math.max(0, 1 - (distance * distance) / 2);
}

export function rankEntities(neighbors: ChunkNeighbor[], links: Link[], k: number): EntitySuggestion[] {
  const entitiesByFile = new Map<string, Set<string>>();
  for (const link of links) {
    if (link.fromType === 'file' && link.toType === 'entity') {
      entitiesByFile.set(link.fromId, (entitiesByFile.get(link.fromId) ?? new Set()).add(link.toId));
    }
  }
  const best = new Map<string, number>();
  for (const neighbor of neighbors) {
    const score = scoreFromDistance(neighbor.distance);
    for (const entityId of entitiesByFile.get(neighbor.ownerId) ?? []) {
      best.set(entityId, Math.max(best.get(entityId) ?? 0, score));
    }
  }
  return [...best]
    .map(([entityId, score]) => ({ entityId, score }))
    .filter((suggestion) => suggestion.score >= SUGGEST_MIN_SCORE)
    .sort((left, right) => right.score - left.score || left.entityId.localeCompare(right.entityId))
    .slice(0, k);
}

let activeDeps: SuggestDeps | undefined;

export function configureSuggestLink(deps: SuggestDeps): void {
  activeDeps = deps;
}

export async function suggestEntityForFile(
  fileId: string,
  k: number = DEFAULT_SUGGESTION_COUNT,
  deps: SuggestDeps | undefined = activeDeps,
): Promise<EntitySuggestion[]> {
  if (!deps) {
    throw new Error('La suggestion de rattachement n’est pas configurée');
  }
  const [neighbors, links] = await Promise.all([deps.neighbors(fileId), deps.listLinks()]);
  return rankEntities(neighbors, links, k);
}
