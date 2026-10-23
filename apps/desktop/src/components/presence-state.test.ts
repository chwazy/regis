import { describe, expect, it } from 'vitest';
import { presenceState } from './presence-state';

describe('presenceState', () => {
  it('vaut idle sans signal', () => {
    expect(presenceState({})).toBe('idle');
  });

  it("donne la priorité à l'enregistrement", () => {
    expect(presenceState({ recording: true, pendingApprovals: 2, listening: true, thinking: true })).toBe(
      'recording',
    );
  });

  it('passe les validations avant l’écoute et la réflexion', () => {
    expect(presenceState({ pendingApprovals: 1, listening: true, thinking: true })).toBe('approval');
    expect(presenceState({ pendingApprovals: 0, listening: true, thinking: true })).toBe('listening');
    expect(presenceState({ thinking: true })).toBe('thinking');
  });
});
