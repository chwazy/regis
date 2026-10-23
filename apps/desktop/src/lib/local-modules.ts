import type { LocalModuleId, LocalModuleStatus } from '@regis/shared';

const BYTES_PER_MEGABYTE = 1024 * 1024;

export const OLLAMA_INSTALL_URL = 'https://ollama.com/download';

export const MODULE_INFO: Record<
  LocalModuleId,
  { name: string; description: string; provenance: string; unknownSize: string }
> = {
  voice: {
    name: 'Voix',
    description: 'Dictée, enregistrement des réunions et transcription, faits localement par whisper.cpp.',
    provenance: 'téléchargé depuis Hugging Face, traité ensuite sur ce PC uniquement',
    unknownSize: '—',
  },
  embeddings: {
    name: 'Recherche sémantique',
    description: 'Retrouve les documents et notes par le sens, avec le modèle bge-m3 servi par Ollama.',
    provenance: 'téléchargé par Ollama, traité ensuite sur ce PC uniquement',
    unknownSize: 'plus d’1 Go',
  },
};

export function formatModuleSize(bytes: number): string {
  return `${Math.round(bytes / BYTES_PER_MEGABYTE)} Mo`;
}

export function modelSizeLabel(status: LocalModuleStatus): string {
  return status.sizeBytes === null ? MODULE_INFO[status.id].unknownSize : formatModuleSize(status.sizeBytes);
}

export function moduleStateLabel(status: LocalModuleStatus): string {
  switch (status.state) {
    case 'on':
      return 'Activé';
    case 'downloading':
      return 'Téléchargement…';
    case 'off':
      if (!status.enabled) {
        return 'Désactivé';
      }
      return status.modelState === 'unreachable'
        ? 'Désactivé · Ollama injoignable'
        : 'Désactivé · modèle absent';
  }
}

export function isSwitchChecked(status: LocalModuleStatus): boolean {
  return (
    status.state === 'on' ||
    status.state === 'downloading' ||
    (status.enabled && status.modelState === 'unreachable')
  );
}

export type ToggleIntent = 'locked' | 'disable' | 'enable' | 'confirmDownload' | 'ollamaHelp';

export function toggleIntent(status: LocalModuleStatus): ToggleIntent {
  if (status.state === 'downloading') {
    return 'locked';
  }
  if (isSwitchChecked(status)) {
    return 'disable';
  }
  switch (status.modelState) {
    case 'ready':
      return 'enable';
    case 'unreachable':
      return 'ollamaHelp';
    case 'missing':
    case 'error':
    case 'downloading':
      return 'confirmDownload';
  }
}

export function deleteModelLabel(status: LocalModuleStatus): string {
  return status.sizeBytes === null
    ? 'Supprimer le modèle'
    : `Supprimer le modèle (${formatModuleSize(status.sizeBytes)})`;
}

export function canDeleteModel(status: LocalModuleStatus): boolean {
  return status.canDeleteModel && !status.enabled && status.modelState === 'ready';
}

export function isModuleOn(modules: readonly LocalModuleStatus[], id: LocalModuleId): boolean {
  return modules.some((module) => module.id === id && module.state === 'on');
}

export function indexingModeLabel(semanticOn: boolean): string {
  return semanticOn ? 'texte + embeddings locaux' : 'texte seul';
}
