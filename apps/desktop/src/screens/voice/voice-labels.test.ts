import { describe, expect, it } from 'vitest';
import { formatMegabytes, modelStateLabel, progressPercent } from './voice-labels';

describe('voice labels', () => {
  it('formats the model size in Mo', () => {
    expect(formatMegabytes(574_041_195)).toBe('547 Mo');
    expect(formatMegabytes(null)).toBe('—');
  });

  it('clamps the download percentage', () => {
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(300, 200)).toBe(100);
    expect(progressPercent(null, 200)).toBe(0);
    expect(progressPercent(10, 0)).toBe(0);
  });

  it('labels every model state in French', () => {
    expect(modelStateLabel('ready')).toBe('Modèle prêt');
    expect(modelStateLabel('missing')).toBe('Modèle non téléchargé');
  });
});
