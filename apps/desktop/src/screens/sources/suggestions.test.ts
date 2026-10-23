import { describe, expect, it } from 'vitest';
import type { Entity } from '@regis/shared';
import { topSuggestedEntity } from './suggestions';

const entity = (id: string, name: string): Entity => ({
  id,
  kind: 'client',
  name,
  tagsJson: [],
  dataJson: {},
  createdAt: '',
  updatedAt: '',
});

describe('topSuggestedEntity', () => {
  const entities = [entity('E1', 'Atelier Rhône SA'), entity('E2', 'Laiterie du Jorat')];

  it('returns the best suggestion that still exists', () => {
    const suggestions = [
      { entityId: 'gone', score: 0.9 },
      { entityId: 'E2', score: 0.7 },
      { entityId: 'E1', score: 0.6 },
    ];

    expect(topSuggestedEntity(suggestions, entities)?.name).toBe('Laiterie du Jorat');
  });

  it('returns nothing without suggestions or entities', () => {
    expect(topSuggestedEntity(undefined, entities)).toBeUndefined();
    expect(topSuggestedEntity([], entities)).toBeUndefined();
    expect(topSuggestedEntity([{ entityId: 'E1', score: 0.9 }], null)).toBeUndefined();
  });
});
