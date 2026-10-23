import { describe, expect, it } from 'vitest';
import {
  countLabel,
  isRenderable,
  parseVariables,
  templateKind,
  withSource,
  type TemplateVariable,
} from './templates-view';

describe('templates view helpers', () => {
  it('keeps only well-formed variables', () => {
    expect(
      parseVariables([{ key: 'client.nom', source: 'brain' }, { key: 'x', source: 'unknown' }, 'nope']),
    ).toEqual([{ key: 'client.nom', source: 'brain' }]);
    expect(parseVariables({})).toEqual([]);
  });

  it('changes the source of one variable only', () => {
    const variables: TemplateVariable[] = [
      { key: 'a', source: 'agent' },
      { key: 'b', source: 'agent' },
    ];

    expect(withSource(variables, 'b', 'ask')).toEqual([
      { key: 'a', source: 'agent' },
      { key: 'b', source: 'ask' },
    ]);
  });

  it('formats counts and kinds', () => {
    expect(countLabel(0, 'usage', 'usages')).toBe('0 usage');
    expect(countLabel(3, 'usage', 'usages')).toBe('3 usages');
    expect(templateKind('docx', true)).toBe('DOCX → PDF');
    expect(templateKind('md', true)).toBe('MD');
    expect(isRenderable('xlsx')).toBe(false);
  });
});
