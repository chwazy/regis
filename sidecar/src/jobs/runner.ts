import type { Agent, Job, JobEvent, JobStatus, NewJob, NewJobEvent } from '@regis/shared';
import type { AgentDriver, ChatTurn } from '../agents/driver';
import { chatHistory } from './chat-history';
import { toJobEvent } from './map-events';
import type { PtyJobs } from './pty-job';
import { prepareWorkdir, type Workdir } from './workdir';

export interface StartJobInput {
  agentId: string;
  title: string;
  prompt: string;
  parentId?: string;
  kind?: 'task' | 'chat' | 'brief' | 'extract' | 'synthesis';
  cwd?: string;
  repoPath?: string;
  contextRefs?: { type: string; id: string }[];
  routingReason?: string;
}

export class JobNotFoundError extends Error {}
export class JobNotResumableError extends Error {}
export class JobWaitTimeoutError extends Error {}

export interface JobStore {
  createJob: (job: NewJob) => Promise<Job>;
  getJob: (id: string) => Promise<Job>;
  updateJob: (id: string, patch: Record<string, unknown>) => Promise<Job>;
  appendEvent: (event: NewJobEvent) => Promise<JobEvent>;
  listEvents: (jobId: string) => Promise<JobEvent[]>;
  listJobs: (status?: JobStatus) => Promise<Job[]>;
}

export interface JobRunnerDeps {
  store: JobStore;
  getAgent: (agentId: string) => Promise<Agent | undefined>;
  getDriver: (agent: Agent) => AgentDriver;
  getSetting: (key: string) => Promise<string | null>;
  getDataDir: () => Promise<string>;
  systemPromptFor?: (job: Job, agent: Agent) => string | undefined;
  ptyJobs?: Pick<PtyJobs, 'start' | 'hasTerminal' | 'closeTerminal'>;
  onLog: (line: string) => void;
}

export const MAX_CONCURRENT_SETTING = 'jobs.maxConcurrent';
export const DEFAULT_MAX_CONCURRENT = 3;
export const INTERRUPTED_ERROR = 'interrupted';

const TERMINAL_STATUSES: JobStatus[] = ['done', 'failed', 'cancelled'];
const MAX_EVENT_SUMMARY_LENGTH = 200;

interface QueuedRun {
  jobId: string;
  parentId: string | null;
  message: string;
  resume: boolean;
  input?: StartJobInput;
}

interface ActiveRun {
  controller: AbortController;
  parentId: string | null;
  finished: Promise<void>;
}

interface RunOutcome {
  resultText: string | null;
  isError: boolean;
  subtype: string | null;
  errorMessage: string | null;
}

export class JobRunner {
  private readonly queue: QueuedRun[] = [];
  private readonly active = new Map<string, ActiveRun>();
  private readonly waiters = new Map<string, (() => void)[]>();
  private readonly suspended = new Map<string, number>();
  private readonly pendingMessages = new Map<string, string[]>();
  private pumping = false;
  private pumpAgain = false;

  constructor(private readonly deps: JobRunnerDeps) {}

  async start(input: StartJobInput): Promise<Job> {
    const agent = await this.deps.getAgent(input.agentId);
    if (!agent) {
      throw new Error(`Agent inconnu : ${input.agentId}`);
    }
    if (agent.mode === 'pty' && this.deps.ptyJobs) {
      return this.deps.ptyJobs.start(input, agent);
    }
    const job = await this.deps.store.createJob({
      parentId: input.parentId ?? null,
      agentId: input.agentId,
      kind: input.kind ?? 'task',
      title: input.title,
      prompt: input.prompt,
      status: 'queued',
      sessionId: null,
      cwd: null,
      routingReason: input.routingReason ?? null,
      resultText: null,
      error: null,
      startedAt: null,
      endedAt: null,
    });
    this.enqueue({
      jobId: job.id,
      parentId: job.parentId,
      message: input.prompt,
      resume: false,
      input,
    });
    return job;
  }

  async cancel(jobId: string): Promise<void> {
    const job = await this.load(jobId);
    await this.cancelDescendants(jobId);
    const queuedIndex = this.queue.findIndex((run) => run.jobId === jobId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      await this.finish(job, 'cancelled', { error: null });
      await this.record(jobId, 'end', 'Arrêté avant le démarrage', { isError: true, subtype: 'aborted' });
      this.settle(jobId);
      return;
    }
    const running = this.active.get(jobId);
    if (running) {
      running.controller.abort();
      await running.finished;
      return;
    }
    await this.deps.ptyJobs?.closeTerminal(jobId);
    if (!TERMINAL_STATUSES.includes(job.status)) {
      await this.finish(job, 'cancelled', { error: null });
    }
  }

  async resume(jobId: string, message: string): Promise<Job> {
    const job = await this.load(jobId);
    if (this.deps.ptyJobs?.hasTerminal(jobId)) {
      throw new JobNotResumableError(`Un terminal est ouvert pour le job ${jobId}`);
    }
    const inFlight = this.isInFlight(jobId);
    if (!inFlight) {
      await this.assertResumable(job);
    }
    await this.record(jobId, 'message', message, { role: 'user', text: message });
    if (inFlight) {
      this.pendingMessages.set(jobId, [...(this.pendingMessages.get(jobId) ?? []), message]);
      return job;
    }
    const queued = await this.deps.store.updateJob(jobId, { status: 'queued', error: null, endedAt: null });
    this.enqueue({ jobId, parentId: job.parentId, message, resume: true });
    return queued;
  }

  async resumeAfterApproval(jobId: string, message: string): Promise<void> {
    const job = await this.load(jobId);
    if (job.status === 'cancelled') {
      return;
    }
    await this.resume(jobId, message);
  }

  async waitForEnd(jobId: string, timeoutMs?: number): Promise<Job> {
    await this.load(jobId);
    if (this.isInFlight(jobId)) {
      await new Promise<void>((resolveWait, rejectWait) => {
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(
                () => rejectWait(new JobWaitTimeoutError(`Le job ${jobId} n’est pas terminé`)),
                timeoutMs,
              );
        const waiting = this.waiters.get(jobId) ?? [];
        waiting.push(() => {
          clearTimeout(timer);
          resolveWait();
        });
        this.waiters.set(jobId, waiting);
      });
    }
    return this.load(jobId);
  }

  async waitForChildEnd(parentId: string, childId: string, timeoutMs?: number): Promise<Job> {
    const tracked = this.active.has(parentId);
    if (tracked) {
      this.suspend(parentId);
    }
    try {
      return await this.waitForEnd(childId, timeoutMs);
    } finally {
      if (tracked) {
        this.unsuspend(parentId);
      }
    }
  }

  private suspend(parentId: string): void {
    const waitingChildren = this.suspended.get(parentId) ?? 0;
    this.suspended.set(parentId, waitingChildren + 1);
    if (waitingChildren === 0) {
      void this.pump();
    }
  }

  private unsuspend(parentId: string): void {
    const waitingChildren = this.suspended.get(parentId);
    if (waitingChildren === undefined) {
      return;
    }
    if (waitingChildren <= 1) {
      this.suspended.delete(parentId);
    } else {
      this.suspended.set(parentId, waitingChildren - 1);
    }
  }

  async recoverInterrupted(): Promise<number> {
    const stale = [
      ...(await this.deps.store.listJobs('running')),
      ...(await this.deps.store.listJobs('queued')),
    ];
    for (const job of stale) {
      await this.finish(job, 'failed', { error: INTERRUPTED_ERROR });
      await this.record(job.id, 'error', 'Interrompu par l’arrêt de l’application', {
        message: INTERRUPTED_ERROR,
      });
    }
    return stale.length;
  }

  private isInFlight(jobId: string): boolean {
    return this.active.has(jobId) || this.queue.some((run) => run.jobId === jobId);
  }

  private async load(jobId: string): Promise<Job> {
    try {
      return await this.deps.store.getJob(jobId);
    } catch (error) {
      throw new JobNotFoundError(`Job introuvable : ${jobId} (${errorMessage(error)})`);
    }
  }

  private async assertResumable(job: Job): Promise<void> {
    const agent = await this.deps.getAgent(job.agentId);
    if (!agent) {
      throw new JobNotResumableError(`Agent introuvable pour le job ${job.id}`);
    }
    const driver = this.deps.getDriver(agent);
    if (driver.supportsResume === true && job.sessionId) {
      return;
    }
    if (driver.supportsHistory === true) {
      return;
    }
    if (!job.sessionId) {
      throw new JobNotResumableError(`Le job ${job.id} n’a pas de session à reprendre`);
    }
    throw new JobNotResumableError(`Le runtime ${agent.runtime} ne permet pas de reprendre une session`);
  }

  private async cancelDescendants(jobId: string): Promise<void> {
    const childIds = [
      ...[...this.active].filter(([, run]) => run.parentId === jobId).map(([id]) => id),
      ...this.queue.filter((run) => run.parentId === jobId).map((run) => run.jobId),
    ];
    await Promise.all(
      childIds.map((childId) =>
        this.cancel(childId).catch((error: unknown) => {
          this.deps.onLog(`[jobs] sous-job ${childId} non arrêté : ${errorMessage(error)}`);
        }),
      ),
    );
  }

  private enqueue(run: QueuedRun): void {
    this.queue.push(run);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const maxConcurrent = await this.readMaxConcurrent();
        while (this.active.size - this.suspended.size < maxConcurrent && this.queue.length > 0) {
          const next = this.queue.shift();
          if (next) {
            this.launch(next);
          }
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private async readMaxConcurrent(): Promise<number> {
    const raw = await this.deps.getSetting(MAX_CONCURRENT_SETTING).catch(() => null);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENT;
  }

  private launch(run: QueuedRun): void {
    const controller = new AbortController();
    const finished = this.execute(run, controller.signal)
      .catch((error: unknown) => {
        this.deps.onLog(`[jobs] job ${run.jobId} en échec inattendu : ${errorMessage(error)}`);
      })
      .then(() => this.afterRun(run.jobId));
    this.active.set(run.jobId, { controller, parentId: run.parentId, finished });
  }

  private async afterRun(jobId: string): Promise<void> {
    this.active.delete(jobId);
    this.suspended.delete(jobId);
    const pending = this.pendingMessages.get(jobId) ?? [];
    this.pendingMessages.delete(jobId);
    if (pending.length > 0 && (await this.requeueWithMessages(jobId, pending))) {
      return;
    }
    this.settle(jobId);
    void this.pump();
  }

  private async requeueWithMessages(jobId: string, messages: string[]): Promise<boolean> {
    try {
      const job = await this.load(jobId);
      if (job.status === 'cancelled') {
        return false;
      }
      const queued = await this.deps.store.updateJob(jobId, { status: 'queued', error: null, endedAt: null });
      this.enqueue({ jobId, parentId: queued.parentId, message: messages.join('\n\n'), resume: true });
      return true;
    } catch (error) {
      this.deps.onLog(`[jobs] messages en attente de ${jobId} perdus : ${errorMessage(error)}`);
      return false;
    }
  }

  private settle(jobId: string): void {
    const waiting = this.waiters.get(jobId) ?? [];
    this.waiters.delete(jobId);
    for (const release of waiting) {
      release();
    }
  }

  private async execute(run: QueuedRun, signal: AbortSignal): Promise<void> {
    const job = await this.load(run.jobId);
    const agent = await this.deps.getAgent(job.agentId);
    if (!agent) {
      await this.fail(job, `Agent introuvable : ${job.agentId}`);
      return;
    }
    let workdir: Workdir | undefined;
    let cwd = job.cwd;
    if (!run.resume) {
      try {
        workdir = await prepareWorkdir({
          dataDir: await this.deps.getDataDir(),
          jobId: job.id,
          worktree: agent.worktreePerJob,
          ...(run.input?.repoPath ? { repoPath: run.input.repoPath } : {}),
          ...(run.input?.cwd ? { cwd: run.input.cwd } : {}),
        });
        cwd = workdir.cwd;
      } catch (error) {
        await this.fail(job, `Dossier de travail impossible : ${errorMessage(error)}`);
        return;
      }
    }
    if (!cwd) {
      await this.fail(job, 'Aucun dossier de travail pour reprendre le job');
      return;
    }
    const running = await this.deps.store.updateJob(job.id, {
      status: 'running',
      cwd,
      error: null,
      endedAt: null,
      ...(job.startedAt === null ? { startedAt: new Date().toISOString() } : {}),
    });
    const startInfo: Record<string, unknown> = {
      cwd,
      resumed: run.resume,
      ...(run.resume
        ? {}
        : { worktree: workdir?.worktree ?? null, contextRefs: run.input?.contextRefs ?? [] }),
    };
    const outcome = await this.stream(running, agent, run, cwd, startInfo, signal);
    await this.conclude(running.id, outcome, signal.aborted);
  }

  private async stream(
    job: Job,
    agent: Agent,
    run: QueuedRun,
    cwd: string,
    startInfo: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    const outcome: RunOutcome = { resultText: null, isError: false, subtype: null, errorMessage: null };
    let costUsd = job.costUsd;
    let tokensIn = job.tokensIn;
    let tokensOut = job.tokensOut;
    const systemPrompt = this.deps.systemPromptFor?.(job, agent);
    try {
      const driver = this.deps.getDriver(agent);
      const resumeSession = run.resume && driver.supportsResume === true && Boolean(job.sessionId);
      const history: ChatTurn[] =
        run.resume && !resumeSession && driver.supportsHistory === true
          ? chatHistory(job, await this.deps.store.listEvents(job.id), run.message)
          : [];
      const events = driver.run({
        jobId: job.id,
        agent,
        prompt: run.message,
        ...(systemPrompt ? { systemPrompt } : {}),
        cwd,
        ...(resumeSession && job.sessionId ? { sessionId: job.sessionId, resume: true } : {}),
        ...(history.length > 0 ? { history } : {}),
        signal,
      });
      for await (const event of events) {
        if (event.type === 'usage') {
          costUsd += event.costUsd;
          tokensIn += event.tokensIn;
          tokensOut += event.tokensOut;
          await this.patchQuietly(job.id, { costUsd, tokensIn, tokensOut });
          continue;
        }
        if (event.type === 'start' && event.sessionId && event.sessionId !== job.sessionId) {
          await this.patchQuietly(job.id, { sessionId: event.sessionId });
        }
        if (event.type === 'end') {
          outcome.resultText = event.resultText;
          outcome.isError = event.isError;
          outcome.subtype = event.subtype ?? null;
        } else if (event.type === 'error') {
          outcome.errorMessage = event.message;
        }
        const mapped = toJobEvent(job.id, event);
        if (mapped) {
          await this.append({
            jobId: mapped.jobId,
            at: mapped.at,
            type: mapped.type,
            summary: signal.aborted && event.type === 'end' ? 'Arrêté par l’utilisateur' : mapped.summary,
            payloadJson:
              event.type === 'start' && isRecord(mapped.payloadJson)
                ? { ...mapped.payloadJson, ...startInfo }
                : mapped.payloadJson,
          });
        }
      }
    } catch (error) {
      outcome.errorMessage = errorMessage(error);
      await this.record(job.id, 'error', outcome.errorMessage, { message: outcome.errorMessage });
    }
    return outcome;
  }

  private async conclude(jobId: string, outcome: RunOutcome, aborted: boolean): Promise<void> {
    const job = await this.load(jobId);
    if (aborted) {
      await this.finish(job, 'cancelled', { error: null, resultText: outcome.resultText });
      return;
    }
    if (outcome.isError || outcome.errorMessage !== null || outcome.resultText === null) {
      const reason =
        outcome.errorMessage ??
        (outcome.resultText || outcome.subtype || 'Le flux de l’agent s’est terminé sans résultat');
      await this.finish(job, 'failed', { error: reason, resultText: outcome.resultText });
      return;
    }
    if (job.status === 'waiting_approval') {
      await this.patchQuietly(job.id, { resultText: outcome.resultText });
      return;
    }
    await this.finish(job, 'done', { error: null, resultText: outcome.resultText });
  }

  private async fail(job: Job, reason: string): Promise<void> {
    await this.record(job.id, 'error', reason, { message: reason });
    await this.finish(job, 'failed', { error: reason });
  }

  private async finish(
    job: Job,
    status: JobStatus,
    fields: { error: string | null; resultText?: string | null },
  ): Promise<void> {
    await this.deps.store.updateJob(job.id, {
      status,
      error: fields.error,
      ...(fields.resultText === undefined ? {} : { resultText: fields.resultText }),
      endedAt: new Date().toISOString(),
    });
  }

  private async patchQuietly(jobId: string, patch: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.store.updateJob(jobId, patch);
    } catch (error) {
      this.deps.onLog(`[jobs] mise à jour de ${jobId} impossible : ${errorMessage(error)}`);
    }
  }

  private async record(
    jobId: string,
    type: NewJobEvent['type'],
    summary: string,
    payloadJson: unknown,
  ): Promise<void> {
    await this.append({ jobId, at: new Date().toISOString(), type, summary: clip(summary), payloadJson });
  }

  private async append(event: NewJobEvent): Promise<void> {
    try {
      await this.deps.store.appendEvent(event);
    } catch (error) {
      this.deps.onLog(`[jobs] événement ${event.type} non enregistré : ${errorMessage(error)}`);
    }
  }
}

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim() || 'Événement';
  return collapsed.length <= MAX_EVENT_SUMMARY_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_EVENT_SUMMARY_LENGTH - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
