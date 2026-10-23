import { describe, expect, it } from 'vitest';
import { sccacheState } from './doctor-sccache.mjs';

describe('sccacheState', () => {
  it('est actif quand RUSTC_WRAPPER désigne sccache, quel que soit le chemin', () => {
    expect(sccacheState({ RUSTC_WRAPPER: 'sccache' }, true)).toBe('active');
    expect(sccacheState({ RUSTC_WRAPPER: 'C:/tools/SCCACHE.EXE' }, true)).toBe('active');
    expect(sccacheState({ RUSTC_WRAPPER: 'C:\\tools\\sccache.exe' }, false)).toBe('active');
  });

  it('est installé mais inactif quand sccache est dans le PATH sans RUSTC_WRAPPER', () => {
    expect(sccacheState({}, true)).toBe('installed-inactive');
    expect(sccacheState({ RUSTC_WRAPPER: 'other' }, true)).toBe('installed-inactive');
  });

  it('est absent sinon', () => {
    expect(sccacheState({}, false)).toBe('absent');
    expect(sccacheState({ RUSTC_WRAPPER: 'other' }, false)).toBe('absent');
  });
});
