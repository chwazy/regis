import type { Approval, JobEventType, NewApproval, NewJobEvent, ToolInfo } from '@regis/shared';
import { buildPreview } from './preview';

export interface ApprovalDecision {
  status: 'approved' | 'edited' | 'rejected';
  updatedInput?: unknown;
  note?: string;
}

export const DEFERRED_DENY_MESSAGE =
  'Action mise en attente de validation humaine. Ne pas réessayer : le résultat te sera communiqué à la reprise.';

export const WAIT_TIMEOUT_SETTING = 'approvals.waitTimeoutSec';
export const DEFAULT_WAIT_TIMEOUT_SEC = 600;

export interface ApprovalStore {
  createApproval: (approval: NewApproval) => Promise<Approval>;
  updateJob: (jobId: string, patch: Record<string, unknown>) => Promise<void>;
  appendJobEvent: (event: NewJobEvent) => Promise<void>;
  getSetting: (key: string) => Promise<string | null>;
}

export interface ApprovalTools {
  findTool: (qualifiedName: string) => ToolInfo | undefined;
  callTool: (connectorId: string, tool: string, args: unknown) => Promise<unknown>;
}

export interface DeferredOutcome {
  approvalId: string;
  jobId: string;
  tool: string;
  status: 'approved' | 'edited' | 'rejected';
  ok: boolean;
  result?: unknown;
  note?: string;
}

export interface ApprovalServiceDeps {
  store: ApprovalStore;
  tools: ApprovalTools;
  onLog: (line: string) => void;
  onDeferredSettled?: (outcome: DeferredOutcome) => void;
}

interface Waiting {
  jobId: string;
  tool: string;
  settle: (decision: ApprovalDecision) => void;
}

interface Deferred {
  jobId: string;
  tool: string;
  input: unknown;
  updatedInput?: unknown;
  claimed?: boolean;
}

export class ApprovalService {
  private readonly waiting = new Map<string, Waiting>();
  private readonly deferred = new Map<string, Deferred>();

  constructor(private readonly deps: ApprovalServiceDeps) {}

  async request(jobId: string, tool: string, input: unknown): Promise<ApprovalDecision | 'deferred'> {
    const approval = await this.deps.store.createApproval({
      jobId,
      tool,
      inputJson: input,
      previewJson: buildPreview(tool, input),
      decisionNote: null,
      decidedAt: null,
    });
    await this.record(jobId, 'approval_request', `Validation demandée : ${tool}`, {
      approvalId: approval.id,
    });
    const timeoutMs = (await this.readWaitTimeoutSec()) * 1000;
    return new Promise<ApprovalDecision | 'deferred'>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(approval.id);
        this.deferred.set(approval.id, { jobId, tool, input });
        void this.markWaitingApproval(jobId);
        resolve('deferred');
      }, timeoutMs);
      this.waiting.set(approval.id, {
        jobId,
        tool,
        settle: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
      });
    });
  }

  async resolve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const waiting = this.waiting.get(approvalId);
    if (waiting) {
      this.waiting.delete(approvalId);
      await this.record(waiting.jobId, 'approval_resolved', `${waiting.tool} : ${decision.status}`, {
        approvalId,
      });
      waiting.settle(decision);
      return;
    }
    const deferred = this.deferred.get(approvalId);
    if (!deferred) {
      throw new Error(`Validation inconnue ou déjà traitée : ${approvalId}`);
    }
    await this.record(deferred.jobId, 'approval_resolved', `${deferred.tool} : ${decision.status}`, {
      approvalId,
    });
    if (decision.status === 'rejected') {
      this.deferred.delete(approvalId);
      this.deps.onDeferredSettled?.({
        approvalId,
        jobId: deferred.jobId,
        tool: deferred.tool,
        status: 'rejected',
        ok: false,
        ...(decision.note ? { note: decision.note } : {}),
      });
      return;
    }
    if (decision.updatedInput !== undefined) {
      deferred.updatedInput = decision.updatedInput;
    }
    const executed = await this.executeDeferred(approvalId);
    this.deps.onDeferredSettled?.({
      approvalId,
      jobId: deferred.jobId,
      tool: deferred.tool,
      status: decision.status,
      ok: executed.ok,
      result: executed.result,
    });
  }

  async executeDeferred(approvalId: string): Promise<{ ok: boolean; result: unknown }> {
    const deferred = this.deferred.get(approvalId);
    if (!deferred) {
      throw new Error(`Aucune action différée pour la validation ${approvalId}`);
    }
    this.deferred.delete(approvalId);
    const tool = this.deps.tools.findTool(deferred.tool);
    if (!tool) {
      const result = `Outil introuvable : ${deferred.tool}`;
      await this.record(deferred.jobId, 'error', result, { approvalId });
      return { ok: false, result };
    }
    try {
      const result = await this.deps.tools.callTool(
        tool.connectorId,
        tool.name,
        deferred.updatedInput ?? deferred.input,
      );
      await this.record(deferred.jobId, 'tool_result', `${deferred.tool} exécuté après validation`, {
        approvalId,
        result,
      });
      return { ok: true, result };
    } catch (error) {
      const result = error instanceof Error ? error.message : String(error);
      await this.record(deferred.jobId, 'error', `${deferred.tool} : ${result}`, { approvalId });
      return { ok: false, result };
    }
  }

  private async readWaitTimeoutSec(): Promise<number> {
    const raw = await this.deps.store.getSetting(WAIT_TIMEOUT_SETTING);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WAIT_TIMEOUT_SEC;
  }

  private async markWaitingApproval(jobId: string): Promise<void> {
    try {
      await this.deps.store.updateJob(jobId, { status: 'waiting_approval' });
    } catch (error) {
      this.deps.onLog(`[approvals] job ${jobId} non passé en attente : ${String(error)}`);
    }
  }

  private async record(
    jobId: string,
    type: JobEventType,
    summary: string,
    payloadJson: unknown,
  ): Promise<void> {
    try {
      await this.deps.store.appendJobEvent({
        jobId,
        at: new Date().toISOString(),
        type,
        summary,
        payloadJson,
      });
    } catch (error) {
      this.deps.onLog(`[approvals] événement ${type} non enregistré : ${String(error)}`);
    }
  }
}
