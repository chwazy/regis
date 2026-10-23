import { describe, expect, it } from 'vitest';
import type { DetectResult } from '../rpc/handlers/agents';
import { checkPrereqs, hasModel } from './check';

const now = () => new Date('2026-10-22T10:00:00Z');
const report = (detected: DetectResult, word = false) =>
  checkPrereqs({ detect: () => Promise.resolve(detected), wordAvailable: () => Promise.resolve(word), now });
const item = (r: Awaited<ReturnType<typeof report>>, id: string) => r.items.find((i) => i.id === id);

describe('hasModel', () => {
  it('matches the exact name or the name: prefix only', () => {
    expect(hasModel(['bge-m3'], 'bge-m3')).toBe(true);
    expect(hasModel(['bge-m3:latest'], 'bge-m3')).toBe(true);
    expect(hasModel(['bge-m3x'], 'bge-m3')).toBe(false);
  });
});

describe('checkPrereqs', () => {
  it('reports ollama as ok and optional when reachable', async () => {
    const r = await report({ ollama: { url: 'http://x', models: ['bge-m3:latest'] } });
    expect(item(r, 'ollama')?.state).toBe('ok');
    expect(item(r, 'ollama')?.required).toBe(false);
    expect(r.checkedAt).toBe('2026-10-22T10:00:00.000Z');
  });

  it('no longer reports an embedding model item', async () => {
    const r = await report({ ollama: { url: 'http://x', models: ['llama3'] } });
    expect(r.items.map((i) => i.id)).toEqual(['ollama', 'claudeCli', 'wordPdf']);
    expect(r.ollamaModels).toEqual(['llama3']);
  });

  it('reports ollama unreachable as optional with help about semantic search and the local agent', async () => {
    const r = await report({});
    expect(item(r, 'ollama')?.state).toBe('unreachable');
    expect(item(r, 'ollama')?.required).toBe(false);
    expect(item(r, 'ollama')?.help).toContain('recherche sémantique');
  });

  it('handles the claude CLI', async () => {
    const missing = item(await report({}), 'claudeCli');
    expect(missing?.state).toBe('missing');
    expect(missing?.required).toBe(false);
    const ok = item(await report({ claude: { path: '/bin/claude', version: '2.1.0' } }), 'claudeCli');
    expect(ok?.state).toBe('ok');
    expect(ok?.detail).toContain('2.1.0');
  });

  it('handles Word for the PDF export', async () => {
    expect(item(await report({}, true), 'wordPdf')?.state).toBe('ok');
    const missing = item(await report({}), 'wordPdf');
    expect(missing?.state).toBe('missing');
    expect(missing?.required).toBe(false);
  });
});
