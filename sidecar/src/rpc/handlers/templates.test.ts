import { join } from 'node:path';
import { mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job, Template } from '@regis/shared';
import { makeEntity } from '../../brain/test-support';
import type { StartJobInput } from '../../jobs/runner';
import { fixtureFile } from '../../templates/test-support';
import type { TemplatePatch, TemplateStore } from '../../templates/store';
import { buildGeneratePrompt, createTemplatesMethods } from './templates';

const atelier = makeEntity({ id: 'E-atelier', kind: 'client', name: 'Atelier Rhône SA' });

describe('templates RPC methods', () => {
  let dataDir: string;
  let template: Template;
  let started: StartJobInput[];
  let routed: unknown[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'regis-templates-rpc-'));
    mkdirSync(join(dataDir, 'library', 'models'), { recursive: true });
    copyFileSync(fixtureFile('offre.docx'), join(dataDir, 'library', 'models', 'offre.docx'));
    template = {
      id: 'T1',
      fileId: 'F1',
      name: 'Offre machine',
      instructions: 'Ton formel, vouvoiement.',
      variablesJson: [{ key: 'client.nom', source: 'ask' }],
      version: 1,
    };
    started = [];
    routed = [];
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function methods() {
    const store: TemplateStore = {
      getTemplate: () => Promise.resolve(template),
      updateTemplate: (_id, patch: TemplatePatch) => {
        template = { ...template, ...patch } as Template;
        return Promise.resolve(template);
      },
      getFile: () =>
        Promise.resolve({
          id: 'F1',
          sourceId: 's',
          relPath: 'offre.docx',
          ext: 'docx',
          size: 1,
          mtime: '2026-03-01T10:00:00.000Z',
          sha256: null,
          role: 'template',
          status: 'indexed',
          indexedAt: null,
        }),
      registerGenerated: () => Promise.reject(new Error('unused')),
    };
    return createTemplatesMethods({
      store,
      getDataDir: () => Promise.resolve(dataDir),
      getEntity: (id) => Promise.resolve(id === atelier.id ? atelier : undefined),
      route: (request) => {
        routed.push(request);
        return Promise.resolve({ agentId: 'a1', reason: 'redaction' } as Awaited<
          ReturnType<Parameters<typeof createTemplatesMethods>[0]['route']>
        >);
      },
      runner: {
        start: (input) => {
          started.push(input);
          return Promise.resolve({ id: 'J1', title: input.title } as Job);
        },
      },
      pdfAvailable: () => Promise.resolve(false),
    });
  }

  it('detects variables, keeps declared sources and persists them with a new version', async () => {
    const result = await methods()['templates.detect']?.({ templateId: 'T1' });

    expect(result).toEqual({
      variables: [
        { key: 'client.nom', source: 'ask' },
        { key: 'projet.budget_heures', source: 'odoo' },
      ],
    });
    expect(template.variablesJson).toEqual((result as { variables: unknown }).variables);
    expect(template.version).toBe(2);
  });

  it('starts a routed redaction job whose prompt carries the template instructions', async () => {
    const job = await methods()['templates.generate']?.({ templateId: 'T1', entityId: atelier.id });

    expect(job).toMatchObject({ id: 'J1' });
    expect(routed[0]).toMatchObject({ taskType: 'redaction' });
    const prompt = started[0]?.prompt ?? '';
    expect(prompt).toContain('Ton formel, vouvoiement.');
    expect(prompt).toContain('- client.nom: ask');
    expect(prompt).toContain('- projet.budget_heures: odoo');
    expect(prompt).toContain('mcp__regis__render_template');
    expect(started[0]?.contextRefs).toEqual([
      { type: 'entity', id: atelier.id },
      { type: 'template', id: 'T1' },
    ]);
  });

  it('rejects an unknown entity', async () => {
    await expect(methods()['templates.generate']?.({ templateId: 'T1', entityId: 'nope' })).rejects.toThrow(
      'Entité introuvable',
    );
  });

  it('builds a prompt without instructions', () => {
    expect(buildGeneratePrompt({ ...template, instructions: '' }, [], atelier)).toContain(
      'Template instructions: none.',
    );
  });
});
