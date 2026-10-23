import { describe, expect, it } from 'vitest';
import type { Link } from '@regis/shared';
import {
  SUGGEST_MIN_SCORE,
  rankEntities,
  scoreFromDistance,
  suggestEntityForFile,
  type SuggestDeps,
} from './suggest-link';

const fileLink = (fileId: string, entityId: string): Link => ({
  id: `L-${fileId}-${entityId}`,
  fromType: 'file',
  fromId: fileId,
  toType: 'entity',
  toId: entityId,
  rel: 'about',
  origin: 'user',
  confidence: null,
  createdAt: '',
});

const links = [
  fileLink('f-atelier-1', 'E-atelier'),
  fileLink('f-atelier-2', 'E-atelier'),
  fileLink('f-laiterie', 'E-laiterie'),
];

describe('scoreFromDistance', () => {
  it('turns the distance between unit vectors into a cosine similarity', () => {
    expect(scoreFromDistance(0)).toBe(1);
    expect(scoreFromDistance(Math.SQRT2)).toBeCloseTo(0);
    expect(scoreFromDistance(0.5)).toBeCloseTo(0.875);
    expect(scoreFromDistance(5)).toBe(0);
  });
});

describe('suggestEntityForFile', () => {
  it('returns the entity whose linked chunks are the closest, best first', async () => {
    const deps: SuggestDeps = {
      neighbors: (fileId) => {
        expect(fileId).toBe('f-new');
        return Promise.resolve([
          { ownerId: 'f-laiterie', distance: 0.9 },
          { ownerId: 'f-atelier-2', distance: 0.3 },
          { ownerId: 'f-atelier-1', distance: 0.5 },
          { ownerId: 'f-unlinked', distance: 0.1 },
        ]);
      },
      listLinks: () => Promise.resolve(links),
    };

    const suggestions = await suggestEntityForFile('f-new', 3, deps);

    expect(suggestions.map((suggestion) => suggestion.entityId)).toEqual(['E-atelier', 'E-laiterie']);
    expect(suggestions[0]?.score).toBeCloseTo(scoreFromDistance(0.3));
  });

  it('honours k and drops weak matches', async () => {
    const deps: SuggestDeps = {
      neighbors: () =>
        Promise.resolve([
          { ownerId: 'f-atelier-1', distance: 0.2 },
          { ownerId: 'f-laiterie', distance: 1.3 },
        ]),
      listLinks: () => Promise.resolve(links),
    };

    expect(await suggestEntityForFile('f-new', 1, deps)).toHaveLength(1);
    expect(scoreFromDistance(1.3)).toBeLessThan(SUGGEST_MIN_SCORE);
    expect((await suggestEntityForFile('f-new', 5, deps)).map((suggestion) => suggestion.entityId)).toEqual([
      'E-atelier',
    ]);
  });

  it('suggests nothing when no neighbour is linked to an entity', () => {
    expect(rankEntities([{ ownerId: 'f-unlinked', distance: 0.1 }], links, 3)).toEqual([]);
  });
});
