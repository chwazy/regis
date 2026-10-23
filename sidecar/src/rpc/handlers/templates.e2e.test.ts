import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileEntry, Template } from '@regis/shared';
import { makeAgent } from '../../agents/test-support';
import { makeEntity } from '../../brain/test-support';
import { createTemplateTools } from '../../regis-mcp/template-tools';
import { RegisMcpServer } from '../../regis-mcp/server';
import { createTestRunner, type TestRunner } from '../../jobs/test-support';
import { createRoutingService } from '../../routing/service';
import { docxText } from '../../templates/detect';
import { configureRender, type RegisterGeneratedInput } from '../../templates/render';
import type { TemplatePatch, TemplateStore } from '../../templates/store';
import { fixtureFile } from '../../templates/test-support';
import { createTemplatesMethods } from './templates';

const atelier = makeEntity({ id: 'E-atelier', kind: 'client', name: 'Atelier Rhône SA' });

interface GeneratedLink {
  fileId: string;
  jobId: string;
  templateId: string;
  entityId: string | undefined;
}

let testRunner: TestRunner | undefined;
let regis: RegisMcpServer | undefined;

afterEach(async () => {
  await regis?.stop();
  testRunner?.cleanup();
  regis = undefined;
  testRunner = undefined;
});

describe('template generation end to end', () => {
  it('routes a job whose agent calls render_template and registers the generated file', async () => {
    let template: Template = {
      id: 'T1',
      fileId: 'F-model',
      name: 'Offre machine',
      instructions: 'Ton formel, vouvoiement.',
      variablesJson: [{ key: 'client.nom', source: 'ask' }],
      version: 1,
    };
    const registered: RegisterGeneratedInput[] = [];
    const links: GeneratedLink[] = [];
    const files = new Map<string, FileEntry>();
    const modelFile: FileEntry = {
      id: 'F-model',
      sourceId: 'models',
      relPath: 'offre.docx',
      ext: 'docx',
      size: 1,
      mtime: '2026-03-01T10:00:00.000Z',
      sha256: null,
      role: 'template',
      status: 'indexed',
      indexedAt: null,
    };
    files.set(modelFile.id, modelFile);

    const store: TemplateStore = {
      getTemplate: () => Promise.resolve(template),
      updateTemplate: (_id, patch: TemplatePatch) => {
        template = { ...template, ...patch } as Template;
        return Promise.resolve(template);
      },
      getFile: (id) => Promise.resolve(files.get(id) as FileEntry),
      registerGenerated: (input) => {
        registered.push(input);
        const entry: FileEntry = {
          ...modelFile,
          id: `F-generated-${String(registered.length)}`,
          sourceId: 'generated',
          relPath: input.relPath,
          role: 'generated',
          status: 'pending',
        };
        files.set(entry.id, entry);
        links.push({
          fileId: entry.id,
          jobId: input.jobId,
          templateId: input.templateId,
          entityId: input.entityId,
        });
        return Promise.resolve(entry);
      },
    };

    regis = new RegisMcpServer({
      approve: () => Promise.resolve({ behavior: 'allow' }),
      onLog: () => undefined,
      templates: createTemplateTools(),
    });
    const endpoint = regis;
    const settings = { 'agents.defaultAgentId': 'a1' };
    testRunner = createTestRunner({
      fixture: 'render-template',
      fakeEnv: { FAKE_CLAUDE_CALL_REGIS: '1' },
      settings,
      agents: [makeAgent({ id: 'a1' })],
      regisEndpoint: () => endpoint.start(),
    });
    const { runner, dataDir } = testRunner;
    mkdirSync(join(dataDir, 'library', 'models'), { recursive: true });
    copyFileSync(fixtureFile('offre.docx'), join(dataDir, 'library', 'models', 'offre.docx'));
    configureRender({
      getTemplateSource: async (templateId) => {
        const current = await store.getTemplate(templateId);
        const file = await store.getFile(current.fileId);
        return { name: current.name, filePath: join(dataDir, 'library', 'models', file.relPath) };
      },
      generatedRoot: () => Promise.resolve(join(dataDir, 'library', 'generated')),
      registerGenerated: store.registerGenerated,
    });

    const methods = createTemplatesMethods({
      store,
      getDataDir: () => Promise.resolve(dataDir),
      getEntity: (id) => Promise.resolve(id === atelier.id ? atelier : undefined),
      route: createRoutingService({
        listEntities: () => Promise.resolve([atelier]),
        listLinks: () => Promise.resolve([]),
        listJobs: () => Promise.resolve([]),
        listAgents: () => Promise.resolve([...testRunner!.agents.values()]),
        listRules: () => Promise.resolve([]),
        getSetting: (key) => Promise.resolve(settings[key as keyof typeof settings] ?? null),
        getDriver: () => {
          throw new Error('no driver in tests');
        },
        getDataDir: () => Promise.resolve(dataDir),
      }).decide,
      runner,
      pdfAvailable: () => Promise.resolve(false),
    });

    const job = (await methods['templates.generate']?.({
      templateId: 'T1',
      entityId: atelier.id,
    })) as { id: string };
    await runner.waitForEnd(job.id);

    const stored = testRunner.store.jobs.get(job.id);
    expect(stored?.status).toBe('done');
    expect(stored?.agentId).toBe('a1');
    expect(stored?.prompt).toContain('Ton formel, vouvoiement.');
    expect(stored?.prompt).toContain('mcp__regis__render_template');

    expect(registered).toEqual([
      { relPath: `${job.id}/offre.docx`, templateId: 'T1', jobId: job.id, entityId: atelier.id },
    ]);
    const generatedPath = join(dataDir, 'library', 'generated', job.id, 'offre.docx');
    expect(existsSync(generatedPath)).toBe(true);
    const text = await docxText(generatedPath);
    expect(text).toContain('Atelier Rhône SA');
    expect(text).not.toContain('{{');
    expect(files.get('F-generated-1')).toMatchObject({ role: 'generated', sourceId: 'generated' });
    expect(links).toEqual([
      { fileId: 'F-generated-1', jobId: job.id, templateId: 'T1', entityId: atelier.id },
    ]);
  });
});
