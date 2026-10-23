import type { SttModelState } from '@regis/shared';

const BYTES_PER_MEGABYTE = 1024 * 1024;

export const UNSUPPORTED_CAPTURE_MESSAGE = 'Capture audio disponible sous Windows uniquement pour l’instant';

export function formatMegabytes(bytes: number | null): string {
  return bytes === null ? '—' : `${Math.round(bytes / BYTES_PER_MEGABYTE)} Mo`;
}

export function progressPercent(downloaded: number | null, total: number | null): number {
  if (downloaded === null || total === null || total <= 0) {
    return 0;
  }
  return Math.min(100, Math.floor((downloaded / total) * 100));
}

export function modelStateLabel(state: SttModelState): string {
  switch (state) {
    case 'missing':
      return 'Modèle non téléchargé';
    case 'downloading':
      return 'Téléchargement en cours';
    case 'ready':
      return 'Modèle prêt';
    case 'error':
      return 'Erreur';
  }
}
