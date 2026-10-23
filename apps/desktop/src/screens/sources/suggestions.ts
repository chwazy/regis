import type { Entity } from '@regis/shared';

export interface EntitySuggestion {
  entityId: string;
  score: number;
}

export function topSuggestedEntity(
  suggestions: EntitySuggestion[] | undefined,
  entities: Entity[] | null,
): Entity | undefined {
  if (!suggestions || !entities) {
    return undefined;
  }
  for (const suggestion of suggestions) {
    const entity = entities.find((candidate) => candidate.id === suggestion.entityId);
    if (entity) {
      return entity;
    }
  }
  return undefined;
}
