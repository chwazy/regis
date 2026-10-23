import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent, Job } from '@regis/shared';
import type { JobRunner } from '../jobs/runner';
import { NoEligibleAgentError, TASK_TYPES } from '../routing/engine';
import type { DecideRoute } from '../routing/service';

export const REGIS_JOB_TOOLS = ['mcp__regis__spawn_job', 'mcp__regis__job_status', 'mcp__regis__job_result'];
export const MAX_DEPTH_SETTING = 'jobs.maxDepth';
export const DEFAULT_MAX_DEPTH = 2;

const MAX_ANCESTOR_WALK = 50;

export const spawnJobInputShape = {
  title: z.string().min(1),
  prompt: z.string().min(1),
  agentId: z.string().min(1).optional(),
  taskType: z.enum(TASK_TYPES).optional(),
  waitForResult: z.boolean().optional(),
};
export const jobIdInputShape = { jobId: z.string().min(1) };

const spawnJobArguments = z.object(spawnJobInputShape);
const jobIdArguments = z.object(jobIdInputShape);

export interface JobsToolContext {
  jobId: string;
  agentId: string;
}

export interface JobsToolsDeps {
  runner: Pick<JobRunner, 'start' | 'waitForChildEnd'>;
  getJob: (jobId: string) => Promise<Job>;
  lastEventSummary: (jobId: string) => Promise<string | undefined>;
  listAgents: () => Promise<Agent[]>;
  getSetting: (key: string) => Promise<string | null>;
  route: DecideRoute;
}

export interface JobsToolResult {
  isError: boolean;
  payload: unknown;
}

export interface JobsTools {
  spawnJob: (context: JobsToolContext, args: unknown) => Promise<JobsToolResult>;
  jobStatus: (args: unknown) => Promise<JobsToolResult>;
  jobResult: (args: unknown) => Promise<JobsToolResult>;
}

const refuse = (message: string): JobsToolResult => ({ isError: true, payload: { error: message } });
const succeed = (payload: unknown): JobsToolResult => ({ isError: false, payload });

export function createJobsTools(deps: JobsToolsDeps): JobsTools {
  const readMaxDepth = async (): Promise<number> => {
    const raw = await deps.getSetting(MAX_DEPTH_SETTING);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_DEPTH;
  };

  const depthOf = async (jobId: string): Promise<number> => {
    let depth = 0;
    let current = await deps.getJob(jobId);
    while (current.parentId !== null && depth < MAX_ANCESTOR_WALK) {
      depth += 1;
      current = await deps.getJob(current.parentId);
    }
    return depth;
  };

  const spawnJob = async (context: JobsToolContext, args: unknown): Promise<JobsToolResult> => {
    const parsed = spawnJobArguments.safeParse(args);
    if (!parsed.success) {
      return refuse(`Paramètres invalides : ${parsed.error.message}`);
    }
    const agents = await deps.listAgents();
    const caller = agents.find((agent) => agent.id === context.agentId);
    if (!caller?.canSpawn) {
      return refuse('Cet agent n’est pas autorisé à lancer des sous-jobs');
    }
    if (context.jobId === '') {
      return refuse('Job appelant inconnu');
    }
    const maxDepth = await readMaxDepth();
    const childDepth = (await depthOf(context.jobId)) + 1;
    if (childDepth > maxDepth) {
      return refuse(`Profondeur maximale de délégation atteinte (${String(maxDepth)})`);
    }
    let targetAgentId: string;
    let routingReason: string | undefined;
    if (parsed.data.agentId) {
      const requested = agents.find((agent) => agent.id === parsed.data.agentId && agent.enabled);
      if (!requested) {
        return refuse(`Agent inconnu ou désactivé : ${parsed.data.agentId}`);
      }
      targetAgentId = requested.id;
    } else {
      try {
        const decision = await deps.route({
          task: parsed.data.prompt,
          source: 'task',
          ...(parsed.data.taskType ? { taskType: parsed.data.taskType } : {}),
        });
        targetAgentId = decision.agentId;
        routingReason = decision.reason;
      } catch (error) {
        if (error instanceof NoEligibleAgentError) {
          return refuse(error.message);
        }
        throw error;
      }
    }
    const job = await deps.runner.start({
      agentId: targetAgentId,
      title: parsed.data.title,
      prompt: parsed.data.prompt,
      parentId: context.jobId,
      kind: 'task',
      ...(routingReason === undefined ? {} : { routingReason }),
    });
    if (parsed.data.waitForResult !== true) {
      return succeed({ jobId: job.id, status: job.status });
    }
    const finished = await deps.runner.waitForChildEnd(context.jobId, job.id);
    return succeed({
      jobId: finished.id,
      status: finished.status,
      ...(finished.resultText === null ? {} : { resultText: finished.resultText }),
      ...(finished.error === null ? {} : { error: finished.error }),
    });
  };

  const jobStatus = async (args: unknown): Promise<JobsToolResult> => {
    const parsed = jobIdArguments.safeParse(args);
    if (!parsed.success) {
      return refuse(`Paramètres invalides : ${parsed.error.message}`);
    }
    const job = await deps.getJob(parsed.data.jobId).catch(() => undefined);
    if (!job) {
      return refuse(`Job introuvable : ${parsed.data.jobId}`);
    }
    const lastEvent = await deps.lastEventSummary(job.id);
    return succeed({ status: job.status, costUsd: job.costUsd, ...(lastEvent ? { lastEvent } : {}) });
  };

  const jobResult = async (args: unknown): Promise<JobsToolResult> => {
    const parsed = jobIdArguments.safeParse(args);
    if (!parsed.success) {
      return refuse(`Paramètres invalides : ${parsed.error.message}`);
    }
    const job = await deps.getJob(parsed.data.jobId).catch(() => undefined);
    if (!job) {
      return refuse(`Job introuvable : ${parsed.data.jobId}`);
    }
    return succeed({
      status: job.status,
      ...(job.resultText === null ? {} : { resultText: job.resultText }),
      ...(job.error === null ? {} : { error: job.error }),
    });
  };

  return { spawnJob, jobStatus, jobResult };
}

export function registerJobsTools(mcp: McpServer, context: JobsToolContext, tools: JobsTools): void {
  const asContent = (result: JobsToolResult) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(result.payload) }],
    ...(result.isError ? { isError: true } : {}),
  });
  mcp.registerTool(
    'spawn_job',
    {
      description:
        'Creates a sub-job executed by another agent. Set waitForResult to true to get the final text of the sub-job in the response.',
      inputSchema: spawnJobInputShape,
    },
    async (args) => asContent(await tools.spawnJob(context, args)),
  );
  mcp.registerTool(
    'job_status',
    { description: 'Returns the status, cost and last event of a job.', inputSchema: jobIdInputShape },
    async (args) => asContent(await tools.jobStatus(args)),
  );
  mcp.registerTool(
    'job_result',
    { description: 'Returns the final result text or the error of a job.', inputSchema: jobIdInputShape },
    async (args) => asContent(await tools.jobResult(args)),
  );
}
