import { describe, expect, it } from 'vitest';
import type { FileSourceInfo } from '@regis/shared';
import { folderName, sourceState } from './sources-view';

const base: FileSourceInfo = {
  id: 's1',
  kind: 'local',
  path: 'C:\\Clients\\Atelier',
  watchMode: 'realtime',
  pollMinutes: null,
  state: 'idle',
  lastScanAt: null,
  indexed: true,
  fileCount: 10,
  indexedCount: 10,
  pendingCount: 0,
  unclassifiedCount: 0,
};

describe('sources view helpers', () => {
  it('keeps the last segment of a path', () => {
    expect(folderName('C:\\Clients\\Atelier')).toBe('Atelier');
    expect(folderName('\\\\serveur\\partage\\')).toBe('partage');
    expect(folderName('/home/dylan/docs/')).toBe('docs');
    expect(folderName('')).toBe('');
  });

  it('maps a source state to a capitalised label and a tone', () => {
    expect(sourceState(base)).toEqual({ text: 'À jour', tone: 'ok' });
    expect(sourceState({ ...base, pendingCount: 3 })).toEqual({ text: '3 en attente', tone: 'warn' });
    expect(sourceState({ ...base, state: 'indexing', pendingCount: 5 })).toEqual({
      text: 'Indexation 50 %',
      tone: 'accent',
    });
    expect(sourceState({ ...base, state: 'waiting_ollama' }).text).toBe('En attente d’Ollama');
    expect(sourceState({ ...base, state: 'offline' }).tone).toBe('warn');
    expect(sourceState({ ...base, indexed: false, state: 'unknown' })).toEqual({
      text: 'Référence',
      tone: 'muted',
    });
  });
});
