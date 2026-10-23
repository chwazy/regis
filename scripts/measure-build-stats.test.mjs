import { describe, expect, it } from 'vitest';
import { formatTable, median, parseArgs, summarize } from './measure-build-stats.mjs';

describe('median', () => {
  it('gère les tailles impaire, paire et vide', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe('summarize', () => {
  it('calcule médiane, min et max', () => {
    expect(summarize('x', [1, 3, 2])).toEqual({
      scenario: 'x',
      runs: 3,
      median: 2,
      min: 1,
      max: 3,
    });
  });
});

describe('parseArgs', () => {
  it('applique les défauts et lit les options', () => {
    expect(parseArgs([])).toEqual({ runs: 3, full: false, timings: false });
    expect(parseArgs(['--runs', '5', '--full', '--timings'])).toEqual({
      runs: 5,
      full: true,
      timings: true,
    });
  });
  it('refuse --runs invalide', () => {
    expect(() => parseArgs(['--runs', '0'])).toThrow();
    expect(() => parseArgs(['--runs', 'abc'])).toThrow();
    expect(() => parseArgs(['--runs'])).toThrow();
  });
});

describe('formatTable', () => {
  it('produit une ligne par scénario', () => {
    const table = formatTable([summarize('a', [1, 2, 3])]);
    expect(table.split('\n')).toHaveLength(3);
    expect(table).toContain('a');
  });
});
