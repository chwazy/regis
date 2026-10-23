import { describe, expect, it } from 'vitest';
import { insertAtCursor } from './insert-at-cursor';

describe('insertAtCursor', () => {
  it('adds a space between existing text and the transcription', () => {
    expect(insertAtCursor('Bonjour', 7, 7, 'le monde')).toEqual({ value: 'Bonjour le monde', cursor: 16 });
  });

  it('inserts into an empty field without any added space', () => {
    expect(insertAtCursor('', 0, 0, 'le monde')).toEqual({ value: 'le monde', cursor: 8 });
  });

  it('adds a space after the transcription when text follows', () => {
    expect(insertAtCursor('monde', 0, 0, 'Bonjour le')).toEqual({ value: 'Bonjour le monde', cursor: 10 });
  });

  it('does not add a space next to existing whitespace', () => {
    expect(insertAtCursor('Bonjour ', 8, 8, 'toi')).toEqual({ value: 'Bonjour toi', cursor: 11 });
  });

  it('replaces a non-empty selection', () => {
    expect(insertAtCursor('Bonjour tout le monde', 8, 12, 'les')).toEqual({
      value: 'Bonjour les le monde',
      cursor: 11,
    });
  });

  it('leaves the value untouched for an empty or blank transcription', () => {
    expect(insertAtCursor('abc', 1, 2, '')).toEqual({ value: 'abc', cursor: 2 });
    expect(insertAtCursor('abc', 3, 3, '  \n ')).toEqual({ value: 'abc', cursor: 3 });
  });

  it('never injects a trailing line break', () => {
    expect(insertAtCursor('', 0, 0, 'salut\n').value).toBe('salut');
  });
});
