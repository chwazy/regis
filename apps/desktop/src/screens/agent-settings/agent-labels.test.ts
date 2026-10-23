import { describe, expect, it } from 'vitest';
import {
  MODE_OPTIONS,
  RUNTIME_OPTIONS,
  agentSubtitle,
  budgetLabel,
  isEditorDirty,
  isModeAllowed,
  newAgentDraft,
  stateLabel,
  toggleConnector,
  withRuntime,
} from './agent-labels';

describe('agent labels', () => {
  it('marks codex-cli, gemini-cli, pty and acp as planned', () => {
    const unavailableRuntimes = RUNTIME_OPTIONS.filter((option) => !option.available).map(
      (option) => option.value,
    );
    const unavailableModes = MODE_OPTIONS.filter((option) => !option.available).map((option) => option.value);

    expect(unavailableRuntimes).toEqual(['codex-cli', 'gemini-cli']);
    expect(unavailableModes).toEqual(['pty', 'acp']);
  });

  it('keeps local-only consistent with the runtime', () => {
    const base = newAgentDraft();

    expect(withRuntime(base, 'ollama').isLocalOnly).toBe(true);
    expect(withRuntime(base, 'claude-cli').isLocalOnly).toBe(false);
    expect(withRuntime(base, 'anthropic-api').isLocalOnly).toBe(false);
    expect(withRuntime(base, 'claude-cli').mode).toBe('headless');
  });

  it('only allows the mode matching the runtime', () => {
    expect(isModeAllowed('claude-cli', 'headless')).toBe(true);
    expect(isModeAllowed('claude-cli', 'api')).toBe(false);
    expect(isModeAllowed('ollama', 'api')).toBe(true);
    expect(isModeAllowed('claude-cli', 'pty')).toBe(false);
    expect(isModeAllowed('gemini-cli', 'acp')).toBe(false);
    expect(isModeAllowed('gemini-cli', 'headless')).toBe(false);
    expect(isModeAllowed('claude-cli', 'acp')).toBe(false);
  });

  it('toggles connector ids without duplicates', () => {
    const base = newAgentDraft();
    const added = toggleConnector(base, 'c1');
    const removed = toggleConnector(added, 'c1');

    expect(added.connectorIdsJson).toEqual(['c1']);
    expect(removed.connectorIdsJson).toEqual([]);
  });

  it('describes budget and state', () => {
    expect(budgetLabel({ ...newAgentDraft(), runtime: 'claude-cli' })).toBe('quota abo.');
    expect(budgetLabel({ ...newAgentDraft(), budgetDailyUsd: 2 })).toBe('2.00 USD');
    expect(stateLabel({ ...newAgentDraft(), runtime: 'codex-cli' }).text).toBe('prévu');
    expect(stateLabel(newAgentDraft()).text).toBe('activé');
  });

  it('summarises an agent for the list', () => {
    const base = newAgentDraft();

    expect(agentSubtitle({ ...base, budgetDailyUsd: 0.5 })).toBe('API cloud · 0.50 USD/j');
    expect(agentSubtitle(withRuntime(base, 'claude-cli'))).toBe('CLI locale · abonnement');
    expect(agentSubtitle({ ...withRuntime(base, 'ollama'), model: 'qwen3' })).toBe('Modèle local · qwen3');
  });

  it('detects unsaved editor changes', () => {
    const agent = newAgentDraft();
    const initial = { agent, claudeBin: '', apiKey: '' };

    expect(isEditorDirty(initial, { ...initial, claudeBin: ' ' })).toBe(false);
    expect(isEditorDirty(initial, { ...initial, apiKey: 'k' })).toBe(true);
    expect(isEditorDirty(initial, { ...initial, agent: { ...agent, canSpawn: true } })).toBe(true);
  });
});
