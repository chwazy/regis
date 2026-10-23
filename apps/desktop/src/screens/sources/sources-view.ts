import type { FileSourceInfo } from '@regis/shared';
import type { PillTone } from '../../components/ui/StatusPill';

/** Dernier segment d'un chemin (Windows, UNC ou POSIX), pour l'afficher à la place du chemin complet. */
export function folderName(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? path;
}

export interface SourceState {
  text: string;
  tone: PillTone;
}

export function sourceState(source: FileSourceInfo): SourceState {
  switch (source.state) {
    case 'scanning':
      return { text: 'Scan en cours', tone: 'accent' };
    case 'indexing': {
      const done = source.fileCount - source.pendingCount;
      const percent = source.fileCount > 0 ? Math.floor((done * 100) / source.fileCount) : 0;
      return { text: `Indexation ${String(percent)} %`, tone: 'accent' };
    }
    case 'waiting_ollama':
      return { text: 'En attente d’Ollama', tone: 'warn' };
    case 'offline':
      return { text: 'Hors ligne', tone: 'warn' };
    case 'idle':
      return source.pendingCount > 0
        ? { text: `${String(source.pendingCount)} en attente`, tone: 'warn' }
        : { text: 'À jour', tone: 'ok' };
    default:
      return { text: 'En attente', tone: 'accent' };
  }
}
