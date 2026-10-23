import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileEntry } from '@regis/shared';
import type { RegisterGeneratedInput, RenderDeps } from './render';

export const fixtureFile = (name: string): string =>
  fileURLToPath(new URL(`../../../tests/fixtures/templates/${name}`, import.meta.url));

export interface RenderHarness {
  root: string;
  deps: RenderDeps;
  registered: RegisterGeneratedInput[];
  cleanup: () => void;
}

export function createRenderHarness(templates: Record<string, string>): RenderHarness {
  const root = mkdtempSync(join(tmpdir(), 'regis-templates-'));
  const registered: RegisterGeneratedInput[] = [];
  return {
    root,
    registered,
    deps: {
      getTemplateSource: (templateId) => {
        const filePath = templates[templateId];
        return filePath
          ? Promise.resolve({ name: templateId, filePath })
          : Promise.reject(new Error(`unknown template ${templateId}`));
      },
      generatedRoot: () => Promise.resolve(join(root, 'generated')),
      registerGenerated: (input) => {
        registered.push(input);
        const file: FileEntry = {
          id: `F${String(registered.length)}`,
          sourceId: 'generated',
          relPath: input.relPath,
          ext: input.relPath.split('.').pop() ?? '',
          size: 1,
          mtime: '2026-03-01T10:00:00.000Z',
          sha256: null,
          role: 'generated',
          status: 'pending',
          indexedAt: null,
        };
        return Promise.resolve(file);
      },
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
