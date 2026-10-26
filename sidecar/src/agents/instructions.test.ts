import { describe, expect, it } from 'vitest';
import {
  GLOBAL_INSTRUCTIONS_SETTING,
  ORCHESTRATOR_INSTRUCTIONS_SETTING,
  InstructionsError,
  agentInstructionsSetting,
  composeSystemPrompt,
  loadInstructions,
} from './instructions';

const FILE_PATH =
  process.platform === 'win32' ? 'C:\\agents\\orchestrator\\CLAUDE.md' : '/agents/orchestrator/CLAUDE.md';

function deps(settings: Record<string, string>, files: Record<string, string> = {}) {
  return {
    getSetting: (key: string) => Promise.resolve(settings[key] ?? null),
    readText: (path: string) =>
      path in files ? Promise.resolve(files[path] ?? '') : Promise.reject(new Error('ENOENT')),
  };
}

describe('agent instructions', () => {
  it('returns the global then the agent instructions, skipping blank ones', async () => {
    const loaded = await loadInstructions(
      deps({
        [GLOBAL_INSTRUCTIONS_SETTING]: '  Réponds en français.  ',
        [agentInstructionsSetting('a2')]: 'x',
      }),
      'a1',
    );

    expect(loaded).toEqual(['Réponds en français.']);
  });

  it('adds the orchestrator instructions between global and agent ones, in conversations only', async () => {
    const settings = {
      [GLOBAL_INSTRUCTIONS_SETTING]: 'Global',
      [ORCHESTRATOR_INSTRUCTIONS_SETTING]: 'Tu dispatches.',
      [agentInstructionsSetting('a1')]: 'Agent',
    };

    expect(await loadInstructions(deps(settings), 'a1', true)).toEqual(['Global', 'Tu dispatches.', 'Agent']);
    expect(await loadInstructions(deps(settings), 'a1')).toEqual(['Global', 'Agent']);
  });

  it('reads an absolute file path given on a single line', async () => {
    const loaded = await loadInstructions(
      deps({ [agentInstructionsSetting('a1')]: FILE_PATH }, { [FILE_PATH]: '# Régis\nTu coordonnes.\n' }),
      'a1',
    );

    expect(loaded).toEqual(['# Régis\nTu coordonnes.']);
  });

  it('keeps multi-line text and relative paths as plain instructions', async () => {
    const text = `Lis ${FILE_PATH}\npuis réponds.`;
    const loaded = await loadInstructions(
      deps({ [GLOBAL_INSTRUCTIONS_SETTING]: 'notes/regles.md', [agentInstructionsSetting('a1')]: text }),
      'a1',
    );

    expect(loaded).toEqual(['notes/regles.md', text]);
  });

  it('fails loudly when the instructions file cannot be read', async () => {
    await expect(
      loadInstructions(deps({ [agentInstructionsSetting('a1')]: FILE_PATH }), 'a1'),
    ).rejects.toThrow(InstructionsError);
  });

  it('appends the instructions after the built-in prompt', () => {
    expect(composeSystemPrompt('Base', ['Global', 'Agent'])).toBe('Base\n\nGlobal\n\nAgent');
    expect(composeSystemPrompt(undefined, ['Agent'])).toBe('Agent');
    expect(composeSystemPrompt(undefined, [])).toBeUndefined();
  });
});
