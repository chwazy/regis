import type { Agent, AgentRuntime, Job } from '@regis/shared';
import { resolveDefaultAgent } from '../jobs/default-agent';
import type { JobRunner } from '../jobs/runner';

export const ORCHESTRATOR_SYSTEM_PROMPT = [
  'You are the orchestrator of Régis, a personal command hub. The user talks to you in a single conversation.',
  'Split the request into focused tasks and delegate each one with the Régis tool spawn_job (title, prompt, optional agentId, waitForResult).',
  'Use waitForResult true when you need the answer before continuing, and job_status or job_result to follow a job started without waiting.',
  'Give each sub-job a self-contained prompt: it does not see this conversation.',
  'Every write action stays subject to the user approval; never try to work around a refusal.',
  'Answer in the language of the user and summarize what the sub-jobs produced.',
].join('\n');

export const NON_DELEGATING_SYSTEM_PROMPT = [
  'You are the assistant of Régis, a personal command hub. The user talks to you in a single conversation.',
  'You cannot delegate: you are not allowed to create sub-jobs, so answer and work on the requests yourself.',
  'Every write action stays subject to the user approval; never try to work around a refusal.',
  'Answer in the language of the user.',
].join('\n');

export interface ChatSendParams {
  chatJobId?: string;
  text: string;
}

export interface ChatDeps {
  runner: Pick<JobRunner, 'start' | 'resume'>;
  getJob: (jobId: string) => Promise<Job>;
  listAgents: () => Promise<Agent[]>;
  getSetting: (key: string) => Promise<string | null>;
}

const TITLE_LENGTH = 60;
// Seule la CLI Claude Code reçoit le serveur MCP de Régis, donc l'outil spawn_job.
const DELEGATING_RUNTIMES: ReadonlySet<AgentRuntime> = new Set(['claude-cli']);

export class ChatError extends Error {}

export function chatSystemPrompt(job: Job, agent: Agent): string | undefined {
  if (job.kind !== 'chat') {
    return undefined;
  }
  return agent.canSpawn && DELEGATING_RUNTIMES.has(agent.runtime)
    ? ORCHESTRATOR_SYSTEM_PROMPT
    : NON_DELEGATING_SYSTEM_PROMPT;
}

export function createChat(deps: ChatDeps): { send: (params: ChatSendParams) => Promise<Job> } {
  return {
    async send(params) {
      const text = params.text.trim();
      if (text === '') {
        throw new ChatError('Le message est vide');
      }
      if (params.chatJobId) {
        const chat = await deps.getJob(params.chatJobId);
        if (chat.kind !== 'chat') {
          throw new ChatError(`Le job ${chat.id} n’est pas une conversation`);
        }
        return deps.runner.resume(chat.id, text);
      }
      const agent = await resolveDefaultAgent(await deps.listAgents(), deps.getSetting);
      if (!agent) {
        throw new ChatError('Aucun agent disponible pour l’orchestrateur');
      }
      return deps.runner.start({ agentId: agent.id, title: chatTitle(text), prompt: text, kind: 'chat' });
    },
  };
}

function chatTitle(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const clipped = firstLine.length <= TITLE_LENGTH ? firstLine : `${firstLine.slice(0, TITLE_LENGTH - 1)}…`;
  return `Orchestrateur — ${clipped}`;
}
