import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMemoryBrainStore, makeEntity } from '../brain/test-support';
import { createBrainTools } from './brain-tools';
import { REGIS_AGENT_HEADER, REGIS_JOB_HEADER, RegisMcpServer } from './server';

const atelier = makeEntity({ id: 'E-atelier', kind: 'client', name: 'Atelier Rhône SA' });

async function connected() {
  const store = createMemoryBrainStore();
  store.entities = [atelier];
  const regis = new RegisMcpServer({
    approve: () => Promise.resolve({ behavior: 'allow' }),
    brain: createBrainTools({
      search: () => Promise.resolve({ entities: [atelier], documents: [], mails: [], notes: [] }),
      getEntityCard: (id) =>
        id === atelier.id
          ? Promise.resolve({
              entity: atelier,
              synthesis: null,
              stats: { hoursLast30Days: 0, lastMessageAt: null },
              notes: [],
              facts: [],
              resources: [],
              projects: [],
              documents: [],
              timeline: [],
              links: [],
              activeJobs: [],
            })
          : Promise.reject(new Error('missing')),
      store,
    }),
    onLog: () => undefined,
  });
  const { url, token } = await regis.start();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          [REGIS_JOB_HEADER]: 'job-7',
          [REGIS_AGENT_HEADER]: 'a1',
        },
      },
    }),
  );
  return {
    client,
    store,
    stop: async () => {
      await client.close();
      await regis.stop();
    },
  };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text: string }[];
  return content[0]?.text ?? '';
}

describe('regis brain tools', () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it('exposes the brain read and write tools next to approve', async () => {
    const { client, stop } = await connected();
    stops.push(stop);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'approve',
      'brain_add_fact',
      'brain_add_note',
      'brain_add_resource',
      'brain_create_entity',
      'brain_get_entity',
      'brain_link_entities',
      'brain_remove_resource',
      'brain_search',
      'brain_set_fact_status',
      'brain_update_entity',
    ]);
  });

  it('searches and adds a fact sourced to the calling job', async () => {
    const { client, store, stop } = await connected();
    stops.push(stop);

    const search = await client.callTool({ name: 'brain_search', arguments: { query: 'Atelier' } });
    const added = await client.callTool({
      name: 'brain_add_fact',
      arguments: { entityId: 'E-atelier', text: 'Préfère le PDF signé' },
    });

    expect(JSON.parse(textOf(search))).toMatchObject({ entities: [{ name: 'Atelier Rhône SA' }] });
    expect(JSON.parse(textOf(added))).toMatchObject({ status: 'inferred', duplicate: false });
    expect(store.facts).toEqual([
      expect.objectContaining({ sourceType: 'job', sourceId: 'job-7', status: 'inferred' }),
    ]);
  });
});
