import { describe, expect, it } from 'vitest';
import type { LocalModuleStatus } from '@regis/shared';
import {
  canDeleteModel,
  deleteModelLabel,
  indexingModeLabel,
  isModuleOn,
  isSwitchChecked,
  modelSizeLabel,
  moduleStateLabel,
  toggleIntent,
} from './local-modules';

const status = (patch: Partial<LocalModuleStatus> = {}): LocalModuleStatus => ({
  id: 'voice',
  enabled: false,
  state: 'off',
  modelState: 'missing',
  modelLabel: 'large-v3-turbo-q5_0',
  sizeBytes: 574_041_195,
  downloadedBytes: null,
  canDeleteModel: true,
  error: null,
  ...patch,
});

describe('moduleStateLabel', () => {
  it('labels each state', () => {
    expect(moduleStateLabel(status({ enabled: true, state: 'on', modelState: 'ready' }))).toBe('Activé');
    expect(moduleStateLabel(status())).toBe('Désactivé');
    expect(moduleStateLabel(status({ enabled: true, modelState: 'missing' }))).toBe(
      'Désactivé · modèle absent',
    );
    expect(moduleStateLabel(status({ enabled: true, modelState: 'error' }))).toBe(
      'Désactivé · modèle absent',
    );
    expect(moduleStateLabel(status({ enabled: true, modelState: 'unreachable' }))).toBe(
      'Désactivé · Ollama injoignable',
    );
    expect(moduleStateLabel(status({ state: 'downloading', modelState: 'downloading' }))).toBe(
      'Téléchargement…',
    );
  });
});

describe('modelSizeLabel', () => {
  it('formats the catalog size in megabytes', () => {
    expect(modelSizeLabel(status())).toBe('547 Mo');
  });

  it('says « plus d’1 Go » for embeddings until the pull reports its total', () => {
    expect(modelSizeLabel(status({ id: 'embeddings', sizeBytes: null }))).toBe('plus d’1 Go');
    expect(modelSizeLabel(status({ id: 'embeddings', sizeBytes: 1_157_671_200 }))).toBe('1104 Mo');
  });
});

describe('toggleIntent', () => {
  it('locks the switch while downloading', () => {
    expect(toggleIntent(status({ state: 'downloading', modelState: 'downloading' }))).toBe('locked');
  });

  it('enables at once when the model is ready and asks before downloading otherwise', () => {
    expect(toggleIntent(status({ modelState: 'ready' }))).toBe('enable');
    expect(toggleIntent(status({ modelState: 'missing' }))).toBe('confirmDownload');
    expect(toggleIntent(status({ enabled: true, modelState: 'error' }))).toBe('confirmDownload');
  });

  it('shows the Ollama help when it is unreachable and the switch is off', () => {
    expect(toggleIntent(status({ id: 'embeddings', modelState: 'unreachable' }))).toBe('ollamaHelp');
  });

  it('disables an active module, including one waiting for Ollama', () => {
    expect(toggleIntent(status({ enabled: true, state: 'on', modelState: 'ready' }))).toBe('disable');
    const waiting = status({ id: 'embeddings', enabled: true, modelState: 'unreachable' });
    expect(isSwitchChecked(waiting)).toBe(true);
    expect(toggleIntent(waiting)).toBe('disable');
  });
});

describe('model deletion', () => {
  it('is only offered for a disabled module whose model is present', () => {
    expect(canDeleteModel(status({ modelState: 'ready' }))).toBe(true);
    expect(canDeleteModel(status({ enabled: true, state: 'on', modelState: 'ready' }))).toBe(false);
    expect(canDeleteModel(status({ modelState: 'missing' }))).toBe(false);
    expect(canDeleteModel(status({ id: 'embeddings', canDeleteModel: false, modelState: 'ready' }))).toBe(
      false,
    );
  });

  it('shows the size in the label', () => {
    expect(deleteModelLabel(status())).toBe('Supprimer le modèle (547 Mo)');
  });
});

describe('isModuleOn', () => {
  it('is true only for a module in the on state', () => {
    expect(isModuleOn([status({ state: 'on', enabled: true })], 'voice')).toBe(true);
    expect(isModuleOn([status()], 'voice')).toBe(false);
    expect(isModuleOn([], 'voice')).toBe(false);
  });
});

describe('indexingModeLabel', () => {
  it('says text only unless the semantic search is on', () => {
    expect(indexingModeLabel(false)).toBe('texte seul');
    expect(indexingModeLabel(true)).toBe('texte + embeddings locaux');
  });
});
