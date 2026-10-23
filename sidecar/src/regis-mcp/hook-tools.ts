import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Job, JobStatus, NewJobEvent } from '@regis/shared';

export const HOOK_TOOL_NAME = 'job_status_hook';
export const HOOK_EVENTS = ['Stop', 'Notification'] as const;

export const jobStatusHookInputShape = {
  jobId: z.string().min(1),
  event: z.enum(HOOK_EVENTS),
  message: z.string().optional(),
};

const hookArguments = z.object(jobStatusHookInputShape);
const PERMISSION_REQUEST_PATTERN = /\bneeds? your permission\b/i;
const SETTLED_STATUSES: JobStatus[] = ['done', 'failed', 'cancelled'];
const MAX_SUMMARY_LENGTH = 200;

export interface HookToolsDeps {
  isTerminalJob: (jobId: string) => boolean;
  getJob: (jobId: string) => Promise<Job>;
  updateJob: (jobId: string, patch: Record<string, unknown>) => Promise<Job>;
  appendEvent: (event: NewJobEvent) => Promise<unknown>;
}

export interface HookToolResult {
  isError: boolean;
  payload: unknown;
}

export interface HookTools {
  jobStatusHook: (args: unknown) => Promise<HookToolResult>;
}

export function isPermissionRequest(message: string | undefined): boolean {
  return message !== undefined && PERMISSION_REQUEST_PATTERN.test(message);
}

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim() || 'Notification';
  return collapsed.length <= MAX_SUMMARY_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

export function createHookTools(deps: HookToolsDeps): HookTools {
  const jobStatusHook = async (args: unknown): Promise<HookToolResult> => {
    const parsed = hookArguments.safeParse(args);
    if (!parsed.success) {
      return { isError: true, payload: { error: `Paramètres invalides : ${parsed.error.message}` } };
    }
    const { jobId, event, message } = parsed.data;
    if (!deps.isTerminalJob(jobId)) {
      return { isError: true, payload: { error: `Aucun terminal ouvert pour le job ${jobId}` } };
    }
    const job = await deps.getJob(jobId).catch(() => undefined);
    if (!job) {
      return { isError: true, payload: { error: `Job introuvable : ${jobId}` } };
    }
    if (event === 'Stop') {
      if (job.status !== 'cancelled') {
        await deps.updateJob(jobId, { status: 'done', error: null, endedAt: new Date().toISOString() });
      }
      return { isError: false, payload: {} };
    }
    if (message !== undefined && message.trim() !== '') {
      await deps.appendEvent({
        jobId,
        at: new Date().toISOString(),
        type: 'message',
        summary: clip(message),
        payloadJson: { role: 'assistant', text: message, source: 'hook' },
      });
    }
    if (isPermissionRequest(message) && !SETTLED_STATUSES.includes(job.status)) {
      await deps.updateJob(jobId, { status: 'waiting_approval' });
    }
    return { isError: false, payload: {} };
  };
  return { jobStatusHook };
}

export function registerHookTools(mcp: McpServer, tools: HookTools): void {
  mcp.registerTool(
    HOOK_TOOL_NAME,
    {
      description:
        'Reports a Claude Code terminal hook (Stop or Notification) to update the status of a terminal job.',
      inputSchema: jobStatusHookInputShape,
    },
    async (args) => {
      const result = await tools.jobStatusHook(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.payload) }],
        ...(result.isError ? { isError: true } : {}),
      };
    },
  );
}
