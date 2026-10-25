import type {
  Agent,
  Approval,
  ApprovalStatus,
  Brief,
  Connector,
  Entity,
  EntityCard,
  GlobalSearchResult,
  RegisEvent,
  RegisTopic,
  FileSource,
  Item,
  Job,
  JobEvent,
  ItemUpsert,
  Link,
  NewJob,
  NewJobEvent,
  RoutingRule,
  ToolInfo,
  ToolPolicy,
} from '@regis/shared';
import { resolveClaudeBin } from './agents/claude-bin';
import { createDriverRegistry } from './agents/registry';
import { createBriefCollector } from './brief/collect';
import { createBriefGenerator } from './brief/generate';
import { ApprovalService } from './approvals/service';
import { extractFacts, configureExtraction, pickExtractionAgent } from './brain/extract';
import { BrainService } from './brain/service';
import { createHostBrainStore } from './brain/store';
import { SynthesisService, createHostSynthesisStore } from './brain/synthesis';
import { configureSuggestLink, suggestEntityForFile } from './brain/suggest-link';
import { createApprove } from './regis-mcp/approve';
import { createHookTools } from './regis-mcp/hook-tools';
import { createBrainTools } from './regis-mcp/brain-tools';
import { createJobsTools } from './regis-mcp/jobs-tools';
import { createTemplateTools } from './regis-mcp/template-tools';
import { RegisMcpServer } from './regis-mcp/server';
import { DEFAULT_MAX_TRANSCRIPT_CHARS } from './minutes/prompt';
import { approvalFollowUpMessage } from './jobs/approval-follow-up';
import { PtyJobs } from './jobs/pty-job';
import { JobRunner, type JobStore, type StartJobInput } from './jobs/runner';
import { createMethods } from './methods';
import { demoAgentEnv, isDemoMode, seedDemo } from './demo/seed';
import { bootstrapFromOdoo } from './brain/bootstrap';
import { McpHost } from './mcp/host';
import { createLaunchResolver } from './connectors/launch';
import { chatSystemPrompt, createChat } from './orchestrator/chat';
import { join } from 'node:path';
import { parseDefaultWrite } from './policy/resolve';
import { createToolPolicy } from './policy/tool-policy';
import { createAgentsMethods, type DetectResult } from './rpc/handlers/agents';
import { createPrereqsMethods } from './rpc/handlers/prereqs';
import { createApprovalsMethods } from './rpc/handlers/approvals';
import { createBriefMethods } from './rpc/handlers/brief';
import { createBrainMethods } from './rpc/handlers/brain';
import { createMinutesMethods } from './rpc/handlers/minutes';
import { generateMinutes } from './minutes/service';
import type { MinutesContext } from './minutes/prompt';
import { createConnectorMethods } from './rpc/handlers/connectors';
import { createJobsMethods } from './rpc/handlers/jobs';
import { createRoutingMethods } from './rpc/handlers/routing';
import { createTemplatesMethods } from './rpc/handlers/templates';
import { createMcpMethods, startEnabledConnectors, type HostStore } from './rpc/handlers/mcp';
import { createSyncMethods } from './rpc/handlers/sync';
import { createWidgetsMethods } from './rpc/handlers/widgets';
import { createCustomWidgetMethods } from './rpc/handlers/custom-widget';
import { createCustomWidgetGenerator } from './widgets/custom-generate';
import { RpcServer } from './rpc/server';
import { buildRoutingContext, TIMEZONE_SETTING } from './routing/context';
import { DEFAULT_TIMEZONE, NoEligibleAgentError } from './routing/engine';
import { createRoutingService } from './routing/service';
import { SyncEngine, type SyncStore } from './sync/engine';
import { m365Syncer } from './sync/m365';
import { M365Login } from './sync/m365-login';
import { odooSyncer } from './sync/odoo';
import { configureRender, renderTemplate } from './templates/render';
import { createHostTemplateStore } from './templates/store';
import { wordPdfConverter } from './templates/word-pdf';

const toStderr = (...args: unknown[]): void => {
  console.error(...args);
};
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

const demoMode = isDemoMode(process.env);

const emit = (topic: RegisTopic, payload: unknown): void => {
  const event: RegisEvent = { topic, payload, at: new Date().toISOString() };
  server.notify('event', event);
};

const store: HostStore & SyncStore = {
  listConnectors: () => server.call<Connector[]>('store.connectors.list', {}),
  upsertItems: async (items: ItemUpsert[]) => {
    const result = await server.call<{ upserted: number }>('store.items.upsert', { items });
    return result.upserted;
  },
  recordSync: async (connectorId, status, lastSyncAt) => {
    await server.call('store.connectors.recordSync', {
      id: connectorId,
      status,
      ...(lastSyncAt === undefined ? {} : { lastSyncAt }),
    });
  },
};

const resolveSecret = async (secretRef: string): Promise<string | null> => {
  const result = await server.call<{ value: string | null }>('secrets.get', { secretRef });
  return result.value;
};

const agentStore = {
  listAgents: () => server.call<Agent[]>('store.agents.list', {}),
  listConnectors: store.listConnectors,
  getSetting: async (key: string): Promise<string | null> => {
    const result = await server.call<{ value: string | null }>('store.settings.get', { key });
    return result.value;
  },
};

const resolveLaunch = createLaunchResolver(agentStore.getSetting);

const mcpHost = new McpHost({
  resolveLaunch,
  resolveSecret,
  onStatus: (status) => {
    emit('connector.status', status);
    void syncEngine.track(status).catch((error: unknown) => {
      toStderr('[sync] could not update the schedule:', error);
    });
  },
  onLog: toStderr,
});

const syncEngine = new SyncEngine({
  host: mcpHost,
  store,
  onProgress: (progress) => {
    emit('sync.progress', progress);
    if (progress.phase === 'done') {
      brainService.requestRun();
    }
  },
  onLog: toStderr,
});
syncEngine.register(m365Syncer);
syncEngine.register(odooSyncer);

const approvals = new ApprovalService({
  store: {
    createApproval: (approval) => server.call<Approval>('store.approvals.create', approval),
    updateJob: async (jobId, patch) => {
      await server.call('store.jobs.update', { id: jobId, patch });
    },
    appendJobEvent: async (event) => {
      await server.call('store.jobs.appendEvent', event);
    },
    getSetting: agentStore.getSetting,
  },
  tools: {
    findTool: (qualifiedName) => findTool(qualifiedName),
    callTool: (connectorId, tool, args) => mcpHost.callTool(connectorId, tool, args),
  },
  onLog: toStderr,
  onDeferredSettled: (outcome) => {
    void runner
      .resumeAfterApproval(outcome.jobId, approvalFollowUpMessage(outcome))
      .catch((error: unknown) => {
        toStderr('[jobs] could not resume the job after the approval:', error);
      });
  },
});

const findTool = (qualifiedName: string): ToolInfo | undefined =>
  mcpHost.listTools().find((tool) => tool.qualifiedName === qualifiedName);

const toolPolicy = createToolPolicy({
  listRules: async () => {
    const policies = await server.call<ToolPolicy[]>('store.policies.list', {});
    return policies.map((policy) => ({
      agentId: policy.agentId,
      toolPattern: policy.toolPattern,
      policy: policy.policy,
    }));
  },
  getDefaultWrite: async () => {
    const result = await server.call<{ value: string | null }>('store.settings.get', {
      key: 'policy.defaultWrite',
    });
    return parseDefaultWrite(result.value);
  },
  approvals,
});

const jobStore: JobStore = {
  createJob: (job: NewJob) => server.call<Job>('store.jobs.create', job),
  getJob: (id) => server.call<Job>('store.jobs.get', { id }),
  updateJob: (id, patch) => server.call<Job>('store.jobs.update', { id, patch }),
  appendEvent: (event: NewJobEvent) => server.call<JobEvent>('store.jobs.appendEvent', event),
  listEvents: (jobId) => server.call<JobEvent[]>('store.jobs.listEvents', { jobId }),
  listJobs: (status) => server.call<Job[]>('store.jobs.list', status ? { status } : {}),
};

const getDataDir = async (): Promise<string> => {
  const result = await server.call<{ path: string }>('host.dataDir', {});
  return result.path;
};

const templateStore = createHostTemplateStore((method, params) => server.call(method, params));

configureRender({
  getTemplateSource: async (templateId) => {
    const template = await templateStore.getTemplate(templateId);
    const file = await templateStore.getFile(template.fileId);
    return { name: template.name, filePath: join(await getDataDir(), 'library', 'models', file.relPath) };
  },
  generatedRoot: async () => join(await getDataDir(), 'library', 'generated'),
  registerGenerated: templateStore.registerGenerated,
});

const brainStore = createHostBrainStore((method, params) => server.call(method, params));

const brainTools = createBrainTools({
  search: (query) => server.call<GlobalSearchResult>('store.brain.search', { q: query }),
  getEntityCard: (id) => server.call<EntityCard>('store.brain.entityCard', { id }),
  store: brainStore,
});

const regisServer: RegisMcpServer = new RegisMcpServer({
  approve: createApprove({
    authorize: (context, toolName, input) =>
      toolPolicy.authorize({
        agentId: context.agentId,
        jobId: context.jobId,
        qualifiedName: toolName,
        access: findTool(toolName)?.access ?? 'write',
        input,
      }),
  }),
  jobs: createJobsTools({
    runner: {
      start: (input) => runner.start(input),
      waitForChildEnd: (parentId, childId, timeoutMs) => runner.waitForChildEnd(parentId, childId, timeoutMs),
    },
    getJob: jobStore.getJob,
    lastEventSummary: async (jobId) =>
      (await server.call<JobEvent[]>('store.jobs.listEvents', { jobId })).at(-1)?.summary,
    listAgents: agentStore.listAgents,
    getSetting: agentStore.getSetting,
    route: (request) => routing.decide(request),
  }),
  hooks: createHookTools({
    isTerminalJob: (jobId) => ptyJobs.hasTerminal(jobId),
    getJob: jobStore.getJob,
    updateJob: jobStore.updateJob,
    appendEvent: jobStore.appendEvent,
  }),
  brain: brainTools,
  templates: createTemplateTools(),
  onLog: toStderr,
});

const { getDriver } = createDriverRegistry({
  mcpHost,
  store: agentStore,
  resolveSecret,
  resolveLaunch,
  onLog: toStderr,
  policy: toolPolicy,
  regisEndpoint: () => regisServer.start(),
  listReferenceDirs: async () =>
    (await server.call<FileSource[]>('store.sources.list', {}))
      .filter((source) => !source.indexed)
      .map((source) => source.path),
  ...(demoMode ? { extraEnv: demoAgentEnv(process.env) } : {}),
});

const ptyJobs: PtyJobs = new PtyJobs({
  store: jobStore,
  getAgent: async (agentId) => (await agentStore.listAgents()).find((agent) => agent.id === agentId),
  getDataDir,
  resolveBin: () => resolveClaudeBin({ getSetting: agentStore.getSetting }),
  listConnectors: agentStore.listConnectors,
  listTools: (connectorId) => mcpHost.listTools(connectorId),
  resolveSecret,
  resolveLaunch,
  policy: toolPolicy,
  regisEndpoint: () => regisServer.start(),
  openTerminal: async (jobId, launch, size) => {
    await server.call('pty.open', {
      id: jobId,
      program: launch.program,
      args: launch.args,
      cwd: launch.cwd,
      cols: size.cols,
      rows: size.rows,
      env: launch.env,
    });
  },
  closeTerminal: async (jobId) => {
    await server.call('pty.close', { id: jobId });
  },
  onLog: toStderr,
});

const runner = new JobRunner({
  store: jobStore,
  getAgent: async (agentId) => (await agentStore.listAgents()).find((agent) => agent.id === agentId),
  getDriver,
  getSetting: agentStore.getSetting,
  getDataDir,
  systemPromptFor: chatSystemPrompt,
  ptyJobs,
  onLog: toStderr,
});

const routing = createRoutingService({
  listEntities: () => server.call<Entity[]>('store.entities.list', {}),
  listLinks: () => server.call<Link[]>('store.links.list', {}),
  listJobs: jobStore.listJobs,
  listAgents: agentStore.listAgents,
  listRules: () => server.call<RoutingRule[]>('store.rules.list', {}),
  getSetting: agentStore.getSetting,
  getDriver,
  getDataDir,
});

const pickAgentForExtraction = async (task: string): Promise<{ agentId: string; reason: string }> => {
  const [agents, rules] = await Promise.all([
    agentStore.listAgents(),
    server.call<RoutingRule[]>('store.rules.list', {}),
  ]);
  const ctx = await buildRoutingContext(
    {
      listEntities: () => server.call<Entity[]>('store.entities.list', {}),
      listLinks: () => server.call<Link[]>('store.links.list', {}),
      listJobs: jobStore.listJobs,
      listAgents: agentStore.listAgents,
      getSetting: agentStore.getSetting,
    },
    { task, taskType: 'extraction', source: 'extraction' },
  );
  const decision = pickExtractionAgent(ctx, rules, agents);
  if (!decision) {
    throw new NoEligibleAgentError('Aucun agent local actif pour l’extraction');
  }
  return decision;
};

configureExtraction({
  runner: { start: (input) => runner.start(input), waitForEnd: (jobId) => runner.waitForEnd(jobId) },
  pickAgent: pickAgentForExtraction,
  store: brainStore,
  failJob: async (jobId, error) => {
    await jobStore.updateJob(jobId, { status: 'failed', error, endedAt: new Date().toISOString() });
    await jobStore.appendEvent({
      jobId,
      at: new Date().toISOString(),
      type: 'error',
      summary: error,
      payloadJson: { message: error },
    });
  },
});

configureSuggestLink({ neighbors: brainStore.neighbors, listLinks: brainStore.listLinks });

const failBackgroundJob = async (jobId: string, error: string): Promise<void> => {
  await jobStore.updateJob(jobId, { status: 'failed', error, endedAt: new Date().toISOString() });
  await jobStore.appendEvent({
    jobId,
    at: new Date().toISOString(),
    type: 'error',
    summary: error,
    payloadJson: { message: error },
  });
};
const synthesisStore = createHostSynthesisStore((method, params) => server.call(method, params));
const synthesisService = new SynthesisService({
  store: synthesisStore,
  runner: { start: (input) => runner.start(input), waitForEnd: (jobId) => runner.waitForEnd(jobId) },
  pickAgent: pickAgentForExtraction,
  failJob: failBackgroundJob,
});
const brainService = new BrainService({
  store: brainStore,
  extract: extractFacts,
  synthesize: () => synthesisService.runPending(),
  onLog: toStderr,
});

const chat = createChat({
  runner,
  getJob: jobStore.getJob,
  listAgents: agentStore.listAgents,
  getSetting: agentStore.getSetting,
});

const collectBriefData = createBriefCollector({
  listItems: (filter) => server.call<Item[]>('store.items.list', filter),
  listLinks: () => server.call<Link[]>('store.links.list', {}),
  listPendingApprovals: () =>
    server.call<Approval[]>('store.approvals.list', { status: 'pending' satisfies ApprovalStatus }),
  listJobs: (status) => jobStore.listJobs(status),
  getSetting: agentStore.getSetting,
});

const getBrief = async (date: string): Promise<Brief | null> =>
  server.call<Brief | null>('store.briefs.get', { date });

const generateBrief = createBriefGenerator({
  collect: collectBriefData,
  getBrief,
  saveBrief: (input) => server.call<Brief>('store.briefs.save', input),
  route: (request) => routing.decide(request),
  runner,
  failJob: async (jobId, error) => {
    await jobStore.updateJob(jobId, { status: 'failed', error });
  },
  onLog: toStderr,
});

const generateCustomWidget = createCustomWidgetGenerator({
  route: (request) => routing.decide(request),
  runner,
  failJob: async (jobId, error) => {
    await jobStore.updateJob(jobId, { status: 'failed', error });
  },
});

const MINUTES_MAX_CHARS_SETTING = 'minutes.maxTranscriptChars';

const minutesTimezone = async (): Promise<string> =>
  (await agentStore.getSetting(TIMEZONE_SETTING)) || DEFAULT_TIMEZONE;

const minutesContext = (transcriptItemId: string): Promise<MinutesContext> =>
  server.call<MinutesContext>('store.minutes.context', { transcriptItemId });

const minutesDeps = {
  store: {
    context: minutesContext,
    save: (input: {
      transcriptItemId: string;
      title: string;
      bodyText: string;
      jobId: string;
      agentId: string;
    }) => server.call<Item>('store.minutes.save', input),
  },
  runner: {
    start: (input: StartJobInput) => runner.start(input),
    waitForEnd: (jobId: string) => runner.waitForEnd(jobId),
  },
  pickAgent: async (task: string, entityIds: string[]) => {
    const decision = await routing.decide({
      task,
      taskType: 'redaction',
      source: 'minutes',
      contextRefs: entityIds.map((id) => ({ type: 'entity', id })),
    });
    const agent = (await agentStore.listAgents()).find((candidate) => candidate.id === decision.agentId);
    return { agentId: decision.agentId, agentName: agent?.name ?? decision.agentId, reason: decision.reason };
  },
  timezone: minutesTimezone,
  maxTranscriptChars: async (): Promise<number> => {
    const parsed = Number.parseInt((await agentStore.getSetting(MINUTES_MAX_CHARS_SETTING)) ?? '', 10);
    return parsed > 0 ? parsed : DEFAULT_MAX_TRANSCRIPT_CHARS;
  },
  failJob: failBackgroundJob,
};

const agentsMethods = createAgentsMethods({
  listAgents: agentStore.listAgents,
  getSetting: agentStore.getSetting,
  getDriver,
});

const server: RpcServer = new RpcServer({
  input: process.stdin,
  output: process.stdout,
  methods: createMethods({
    ...createMcpMethods(mcpHost, store),
    ...createSyncMethods(syncEngine, new M365Login(mcpHost)),
    ...createConnectorMethods(),
    ...createApprovalsMethods({
      approvals,
      policy: toolPolicy,
      findToolAccess: (qualifiedName) => findTool(qualifiedName)?.access,
    }),
    ...createJobsMethods({
      runner,
      chat,
      getJob: jobStore.getJob,
      getDataDir,
      route: (request) => routing.decide(request),
      pty: ptyJobs,
    }),
    ...createBriefMethods({
      generate: generateBrief,
      getBrief,
      collect: collectBriefData,
      getSetting: agentStore.getSetting,
    }),
    ...createRoutingMethods((request) => routing.decide(request)),
    ...createWidgetsMethods({
      findTool: (connectorId, tool) => mcpHost.listTools(connectorId).find((info) => info.name === tool),
      callTool: (connectorId, tool, args) => mcpHost.callTool(connectorId, tool, args),
      getSetting: agentStore.getSetting,
    }),
    ...createTemplatesMethods({
      store: templateStore,
      getDataDir,
      getEntity: async (entityId) =>
        (await server.call<Entity[]>('store.entities.list', {})).find((entity) => entity.id === entityId),
      route: (request) => routing.decide(request),
      runner: { start: (input) => runner.start(input) },
      pdfAvailable: wordPdfConverter.available,
    }),
    ...createCustomWidgetMethods({ generate: generateCustomWidget }),
    ...createBrainMethods({
      requestRun: () => brainService.requestRun(),
      refreshSynthesis: (entityId) =>
        synthesisService.refresh(entityId).catch((error: unknown) => {
          toStderr('[brain] synthèse en échec :', error);
        }),
      suggestEntityForFile: (fileId, k) => suggestEntityForFile(fileId, k),
    }),
    ...createMinutesMethods({
      generate: (transcriptItemId) => generateMinutes(transcriptItemId, minutesDeps),
      getNote: async (itemId) =>
        (await server.call<Item[]>('store.items.list', { kind: 'note' })).find((item) => item.id === itemId),
      getJob: jobStore.getJob,
      context: minutesContext,
      timezone: minutesTimezone,
      agentName: async (agentId) =>
        (await agentStore.listAgents()).find((agent) => agent.id === agentId)?.name ?? agentId,
      render: renderTemplate,
    }),
    ...agentsMethods,
    ...createPrereqsMethods({
      detect: () => agentsMethods['agents.detect']?.(null) as Promise<DetectResult>,
      wordAvailable: wordPdfConverter.available,
      now: () => new Date(),
    }),
  }),
  onLog: toStderr,
});
server.start();
brainService.start();
if (demoMode) {
  void (async () => {
    const result = await seedDemo({
      listConnectors: store.listConnectors,
      listAgents: agentStore.listAgents,
      listJobs: () => jobStore.listJobs(),
      upsertItems: store.upsertItems,
      bootstrapBrain: () => bootstrapFromOdoo(brainStore),
      syntheses: synthesisStore,
      createJob: jobStore.createJob,
      appendEvent: jobStore.appendEvent,
      updateJob: jobStore.updateJob,
      requestApproval: (jobId, tool, input) => approvals.request(jobId, tool, input),
      now: () => new Date(),
      onLog: toStderr,
      timeZone: (await agentStore.getSetting(TIMEZONE_SETTING)) || DEFAULT_TIMEZONE,
    });
    toStderr(
      `[demo] ${String(result.items)} élément(s), ${String(result.syntheses)} synthèse(s), ${String(result.jobs)} job(s), ${String(result.approvals)} validation(s) de démo`,
    );
  })().catch((error: unknown) => {
    toStderr('[demo] could not seed the demo data:', error);
  });
}
void startEnabledConnectors(mcpHost, store, toStderr).catch((error: unknown) => {
  toStderr('[mcp] could not start enabled connectors:', error);
});
void runner
  .recoverInterrupted()
  .then((count) => {
    if (count > 0) {
      toStderr(`[jobs] ${String(count)} interrupted job(s) marked as failed`);
    }
  })
  .catch((error: unknown) => {
    toStderr('[jobs] could not recover interrupted jobs:', error);
  });
process.stdin.on('end', () => {
  syncEngine.stop();
  brainService.stop();
  void Promise.all([mcpHost.stopAll(), regisServer.stop()]).finally(() => process.exit(0));
});
