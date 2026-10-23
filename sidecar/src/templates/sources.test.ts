import { describe, expect, it } from 'vitest';
import { mergeVariables, suggestSource } from './sources';

describe('suggestSource', () => {
  it.each([
    ['client.nom', 'brain'],
    ['contact.email', 'brain'],
    ['projet.reference', 'odoo'],
    ['exigences', 'agent'],
  ] as const)('maps %s to %s', (key, source) => {
    expect(suggestSource(key)).toBe(source);
  });
});

describe('mergeVariables', () => {
  it('keeps the declared source of a known key and suggests one for a new key', () => {
    const merged = mergeVariables(
      [
        { key: 'client.nom', source: 'ask' },
        { key: 'gone', source: 'agent' },
      ],
      ['client.nom', 'projet.reference'],
    );

    expect(merged).toEqual([
      { key: 'client.nom', source: 'ask' },
      { key: 'projet.reference', source: 'odoo' },
    ]);
  });

  it('ignores a malformed stored value', () => {
    expect(mergeVariables({ nope: true }, ['a'])).toEqual([{ key: 'a', source: 'agent' }]);
  });
});
