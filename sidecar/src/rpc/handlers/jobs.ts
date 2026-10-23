import { z } from 'zod';
import { RpcErrorCode, type Job } from '@regis/shared';
import type { PtyJobs } from '../../jobs/pty-job';
import { cleanupWorktree, jobDirectory, type CleanupResult } from '../../jobs/workdir';
import {
  JobNotFoundError,
  JobNotResumableError,
  type JobRunner,
  type StartJobInput,
} from '../../jobs/runner';
import { ChatError, type ChatSendParams } from '../../orchestrator/chat';
import { NoEligibleAgentError, TASK_TYPES } from '../../routing/engine';
import type { DecideRoute } from '../../routing/service';
import { RpcMethodError, type MethodHandler } from '../server';

export interface JobsHandlerDeps {
  runner: Pick<JobRunner, 'start' | 'cancel' | 'resume'>;
  chat: { send: (params: ChatSendParams) => Promise<Job> };
  getJob: (jobId: string) => Promise<Job>;
  getDataDir: () => Promise<string>;
  route: DecideRoute;
  pty?: Pick<PtyJobs, 'open' | 'end'>;
}

const startParams = z.object({
  agentId: z.string().min(1).optional(),
  taskType: z.enum(TASK_TYPES).optional(),
  source: z.string().min(1).optional(),
  title: z.string().min(1),
  prompt: z.string().min(1),
  parentId: z.string().min(1).optional(),
  kind: z.enum(['task', 'chat', 'brief', 'extract', 'synthesis']).optional(),
  cwd: z.string().min(1).optional(),
  repoPath: z.string().min(1).optional(),
  contextRefs: z.array(z.object({ type: z.string(), id: z.string() })).optional(),
});
const jobIdParams = z.object({ jobId: z.string().min(1) });
const resumeParams = z.object({ jobId: z.string().min(1), message: z.string().min(1) });
const openPtyParams = z.object({
  jobId: z.string().min(1),
  resume: z.boolean().optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
const endPtyParams = z.object({
  jobId: z.string().min(1),
  code: z.number().int().nullable(),
  requested: z.boolean(),
});
const chatParams = z.object({ chatJobId: z.string().min(1).optional(), text: z.string() });

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
  }
  return parsed.data;
}

async function translated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof JobNotFoundError ||
      error instanceof JobNotResumableError ||
      error instanceof ChatError
    ) {
      throw new RpcMethodError(RpcErrorCode.InvalidParams, error.message);
    }
    if (error instanceof NoEligibleAgentError) {
      throw new RpcMethodError(RpcErrorCode.Unavailable, error.message);
    }
    throw error;
  }
}

function requirePty(deps: JobsHandlerDeps): NonNullable<JobsHandlerDeps['pty']> {
  if (!deps.pty) {
    throw new RpcMethodError(RpcErrorCode.NotConfigured, 'Le mode terminal n’est pas configuré');
  }
  return deps.pty;
}

export function createJobsMethods(deps: JobsHandlerDeps): Record<string, MethodHandler> {
  return {
    'jobs.start': async (params) => {
      const { taskType, source, agentId, ...rest } = parseParams(startParams, params);
      return await translated(async () => {
        if (agentId !== undefined) {
          return deps.runner.start({ ...rest, agentId });
        }
        const decision = await deps.route({
          task: rest.prompt,
          ...(taskType ? { taskType: taskType } : {}),
          source: source ?? rest.kind ?? 'task',
          ...(rest.contextRefs ? { contextRefs: rest.contextRefs } : {}),
        });
        const input: StartJobInput = { ...rest, agentId: decision.agentId, routingReason: decision.reason };
        return deps.runner.start(input);
      });
    },
    'jobs.cancel': async (params) => {
      const { jobId } = parseParams(jobIdParams, params);
      return await translated(async () => {
        await deps.runner.cancel(jobId);
        return {};
      });
    },
    'jobs.resume': async (params) => {
      const { jobId, message } = parseParams(resumeParams, params);
      return await translated(() => deps.runner.resume(jobId, message));
    },
    'jobs.cleanup': async (params) => {
      const { jobId } = parseParams(jobIdParams, params);
      return await translated(async (): Promise<CleanupResult> => {
        const job = await deps.getJob(jobId).catch(() => {
          throw new JobNotFoundError('Job introuvable');
        });
        const expected = jobDirectory(await deps.getDataDir(), job.id);
        if (job.cwd !== expected) {
          return { removed: false, reason: 'Ce job n’a pas de worktree à nettoyer' };
        }
        return cleanupWorktree(expected);
      });
    },
    'jobs.openPty': async (params) => {
      const { jobId, resume, cols, rows } = parseParams(openPtyParams, params);
      const pty = requirePty(deps);
      return await translated(async () => {
        await pty.open(jobId, resume === true, { cols, rows });
        return {};
      });
    },
    'jobs.endPty': async (params) => {
      const { jobId, code, requested } = parseParams(endPtyParams, params);
      const pty = requirePty(deps);
      return await translated(async () => {
        await pty.end(jobId, { code, requested });
        return {};
      });
    },
    'chat.send': async (params) => {
      const input = parseParams(chatParams, params);
      return await translated(() =>
        deps.chat.send({ text: input.text, ...(input.chatJobId ? { chatJobId: input.chatJobId } : {}) }),
      );
    },
  };
}
