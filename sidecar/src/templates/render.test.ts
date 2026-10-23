import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docxText } from './detect';
import { configureRender, renderTemplate } from './render';
import { createRenderHarness, fixtureFile, type RenderHarness } from './test-support';

describe('renderTemplate', () => {
  let harness: RenderHarness;
  beforeEach(() => {
    harness = createRenderHarness({ offre: fixtureFile('offre.docx'), relance: fixtureFile('relance.md') });
    configureRender(harness.deps);
  });
  afterEach(() => {
    harness.cleanup();
  });

  it('fills every variable of a DOCX and keeps the fixed text', async () => {
    const result = await renderTemplate({
      templateId: 'offre',
      jobId: 'J1',
      entityId: 'E1',
      values: { 'client.nom': 'Atelier Rhône SA', 'projet.budget_heures': 120 },
    });

    const text = await docxText(join(harness.root, 'generated', 'J1', 'offre.docx'));
    expect(text).toContain('Offre pour Atelier Rhône SA');
    expect(text).toContain('120 heures');
    expect(text).toContain('Conditions générales : texte fixe, ne pas modifier.');
    expect(text).not.toContain('{{');
    expect(result).toEqual({ fileIds: ['F1'], missing: [], warnings: [] });
  });

  it('leaves a missing value empty and reports it', async () => {
    const result = await renderTemplate({
      templateId: 'offre',
      jobId: 'J2',
      values: { 'client.nom': 'Atelier Rhône SA' },
    });

    expect(result.missing).toEqual(['projet.budget_heures']);
    expect(await docxText(join(harness.root, 'generated', 'J2', 'offre.docx'))).not.toContain('{{');
  });

  it('writes under library/generated/<jobId> and registers the file with its links', async () => {
    await renderTemplate({
      templateId: 'relance',
      jobId: 'J3',
      entityId: 'E1',
      values: { 'client.nom': 'Atelier Rhône SA', 'contact.nom': 'Mme Roux', 'projet.reference': 'P-12' },
    });

    expect(harness.registered).toEqual([
      { relPath: 'J3/relance.md', templateId: 'relance', jobId: 'J3', entityId: 'E1' },
    ]);
    const content = readFileSync(join(harness.root, 'generated', 'J3', 'relance.md'), 'utf8');
    expect(content).toContain('la facture P-12 de Atelier Rhône SA');
    expect(content).not.toContain('{{');
  });

  it('never touches the template and does not overwrite a previous output', async () => {
    const before = readFileSync(fixtureFile('relance.md'));
    const input = { templateId: 'relance', jobId: 'J4', values: {} };
    await renderTemplate(input);
    await renderTemplate(input);

    expect(readFileSync(fixtureFile('relance.md')).equals(before)).toBe(true);
    expect(existsSync(join(harness.root, 'generated', 'J4', 'relance (2).md'))).toBe(true);
  });

  it('produces the DOCX alone with a warning when Word is absent', async () => {
    configureRender({
      ...harness.deps,
      pdf: {
        available: () => Promise.resolve(false),
        convert: () => Promise.reject(new Error('unexpected')),
      },
    });
    const result = await renderTemplate({ templateId: 'offre', jobId: 'J5', values: {}, toPdf: true });

    expect(result.fileIds).toEqual(['F1']);
    expect(result.warnings).toHaveLength(1);
  });

  it('registers the PDF exported next to the DOCX when Word is available', async () => {
    const conversions: [string, string][] = [];
    configureRender({
      ...harness.deps,
      pdf: {
        available: () => Promise.resolve(true),
        convert: (source, target) => {
          conversions.push([source, target]);
          writeFileSync(target, '%PDF');
          return Promise.resolve();
        },
      },
    });
    const result = await renderTemplate({ templateId: 'offre', jobId: 'J6', values: {}, toPdf: true });

    const outDir = join(harness.root, 'generated', 'J6');
    expect(conversions).toEqual([[join(outDir, 'offre.docx'), join(outDir, 'offre.pdf')]]);
    expect(harness.registered.map((entry) => entry.relPath)).toEqual(['J6/offre.docx', 'J6/offre.pdf']);
    expect(result.warnings).toEqual([]);
  });

  it('keeps the DOCX and reports a warning when the Word export fails', async () => {
    configureRender({
      ...harness.deps,
      pdf: {
        available: () => Promise.resolve(true),
        convert: () => Promise.reject(new Error('Word en échec')),
      },
    });
    const result = await renderTemplate({ templateId: 'offre', jobId: 'J7', values: {}, toPdf: true });

    expect(result.fileIds).toEqual(['F1']);
    expect(result.warnings).toEqual(['Word en échec']);
  });

  it('refuses a job id that could escape the library', async () => {
    await expect(renderTemplate({ templateId: 'offre', jobId: '../x', values: {} })).rejects.toThrow();
  });
});
