import { describe, expect, it } from 'vitest';
import { MinutesFormatError, parseMinutesOutput } from './schema';

const valid = {
  summary: 'Point sur le projet.',
  decisions: ['Valider le devis'],
  actions: [{ task: 'Envoyer le devis', owner: 'Dylan' }],
  openPoints: [],
};

describe('parseMinutesOutput', () => {
  it('accepts a bare JSON object', () => {
    expect(parseMinutesOutput(JSON.stringify(valid))).toEqual(valid);
  });

  it('accepts the same JSON in a ```json block, with surrounding text', () => {
    const text = `Voici le PV :\n\`\`\`json\n${JSON.stringify(valid, null, 2)}\n\`\`\`\nBonne journée.`;
    expect(parseMinutesOutput(text)).toEqual(valid);
  });

  it('extracts the first JSON object from a text answer', () => {
    expect(parseMinutesOutput(`Résultat : ${JSON.stringify(valid)} fin`)).toEqual(valid);
  });

  it('throws MinutesFormatError on free text', () => {
    expect(() => parseMinutesOutput('Désolé, je ne peux pas.')).toThrow(MinutesFormatError);
  });

  it('throws MinutesFormatError on a JSON without summary', () => {
    const rest = { decisions: [], actions: [], openPoints: [] };
    expect(() => parseMinutesOutput(JSON.stringify(rest))).toThrow(MinutesFormatError);
  });

  it('throws MinutesFormatError when an action has no task', () => {
    const broken = { ...valid, actions: [{ owner: 'Dylan' }] };
    expect(() => parseMinutesOutput(JSON.stringify(broken))).toThrow(MinutesFormatError);
  });
});
