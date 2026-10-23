import { z } from 'zod';
import { OdooRpcError, type OdooClient } from './client';

export interface TimesheetCreateInput {
  projectId: number;
  taskId?: number;
  date: string;
  hours: number;
  description: string;
}

export interface TaskUpdateStageInput {
  taskId: number;
  stageId: number;
}

export const MODEL_MISSING_PREFIX = 'Modèle Odoo absent';
export const MAX_TIMESHEET_HOURS = 24;
export const DEFAULT_LIMIT = 200;
export const DEFAULT_TIMESHEET_DAYS = 14;
export const DEFAULT_INVOICE_DAYS = 90;
export const DEFAULT_TIME_ZONE = 'Europe/Zurich';

const MODEL_MISSING_PATTERN = /doesn't exist|does not exist|KeyError/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLOSED_TASK_STATES = ['1_done', '1_canceled'];

const PARTNER_FIELDS = ['name', 'email', 'phone', 'is_company', 'parent_id', 'write_date'];
const PROJECT_FIELDS = ['name', 'partner_id', 'user_id', 'date_start', 'date', 'description', 'write_date'];
const TASK_FIELDS = [
  'name',
  'project_id',
  'stage_id',
  'partner_id',
  'date_deadline',
  'priority',
  'state',
  'description',
  'write_date',
];
const TIMESHEET_FIELDS = ['date', 'name', 'unit_amount', 'project_id', 'task_id', 'write_date'];
const INVOICE_FIELDS = [
  'name',
  'partner_id',
  'invoice_date',
  'invoice_date_due',
  'amount_total',
  'currency_id',
  'payment_state',
  'state',
  'write_date',
];

export class OdooToolError extends Error {}

export interface OdooTool {
  name: string;
  description: string;
  readOnly: boolean;
  inputShape: z.ZodRawShape;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolCallResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function calendarDateDaysAgo(days: number, now: Date, timeZone: string): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [year, month, day] = today.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) - days)).toISOString().slice(0, 10);
}

async function readOne(client: OdooClient, model: string, id: number, fields: string[]): Promise<unknown> {
  const rows = await client.executeKw(model, 'read', [[id]], { fields }, z.array(z.unknown()));
  if (rows.length === 0) {
    throw new OdooToolError(`Enregistrement introuvable : ${model} #${id}`);
  }
  return rows[0];
}

const limitShape = { limit: z.number().int().positive().max(1000).optional() };

function limitOf(input: Record<string, unknown>): number {
  return typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT;
}

function daysOf(input: Record<string, unknown>, fallback: number): number {
  return typeof input.days === 'number' ? input.days : fallback;
}

export function createOdooTools(
  client: OdooClient,
  now: () => Date = () => new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): OdooTool[] {
  return [
    {
      name: 'partner_search',
      description:
        'Recherche des partenaires (clients, contacts) par nom ; sans requête, liste les plus récents.',
      readOnly: true,
      inputShape: { query: z.string().optional(), ...limitShape },
      run: (input) => {
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        return client.searchRead('res.partner', query ? [['name', 'ilike', query]] : [], PARTNER_FIELDS, {
          limit: limitOf(input),
          order: 'write_date desc',
        });
      },
    },
    {
      name: 'project_list',
      description: 'Liste les projets actifs.',
      readOnly: true,
      inputShape: limitShape,
      run: (input) =>
        client.searchRead('project.project', [], PROJECT_FIELDS, {
          limit: limitOf(input),
          order: 'write_date desc',
        }),
    },
    {
      name: 'project_read',
      description: 'Lit un projet par son identifiant.',
      readOnly: true,
      inputShape: { projectId: z.number().int().positive() },
      run: (input) => readOne(client, 'project.project', input.projectId as number, PROJECT_FIELDS),
    },
    {
      name: 'task_list',
      description: 'Liste les tâches, ouvertes par défaut, éventuellement limitées à un projet.',
      readOnly: true,
      inputShape: {
        projectId: z.number().int().positive().optional(),
        includeClosed: z.boolean().optional(),
        ...limitShape,
      },
      run: (input) => {
        const domain: unknown[] = [];
        if (input.includeClosed !== true) {
          domain.push(['state', 'not in', CLOSED_TASK_STATES]);
        }
        if (typeof input.projectId === 'number') {
          domain.push(['project_id', '=', input.projectId]);
        }
        return client.searchRead('project.task', domain, TASK_FIELDS, {
          limit: limitOf(input),
          order: 'write_date desc',
        });
      },
    },
    {
      name: 'timesheet_list',
      description: 'Liste les lignes d’heures des derniers jours.',
      readOnly: true,
      inputShape: {
        days: z.number().int().positive().max(366).optional(),
        projectId: z.number().int().positive().optional(),
        ...limitShape,
      },
      run: (input) => {
        const since = calendarDateDaysAgo(daysOf(input, DEFAULT_TIMESHEET_DAYS), now(), timeZone);
        const domain: unknown[] = [['date', '>=', since]];
        if (typeof input.projectId === 'number') {
          domain.push(['project_id', '=', input.projectId]);
        }
        return client.searchRead('account.analytic.line', domain, TIMESHEET_FIELDS, {
          limit: limitOf(input),
          order: 'date desc',
        });
      },
    },
    {
      name: 'invoice_list',
      description: 'Liste les factures client des derniers jours (lecture seule).',
      readOnly: true,
      inputShape: { days: z.number().int().positive().max(730).optional(), ...limitShape },
      run: (input) => {
        const since = calendarDateDaysAgo(daysOf(input, DEFAULT_INVOICE_DAYS), now(), timeZone);
        return client.searchRead(
          'account.move',
          [
            ['move_type', '=', 'out_invoice'],
            ['invoice_date', '>=', since],
            ['state', '!=', 'cancel'],
          ],
          INVOICE_FIELDS,
          { limit: limitOf(input), order: 'invoice_date desc' },
        );
      },
    },
    {
      name: 'invoice_read',
      description: 'Lit une facture client par son identifiant (lecture seule).',
      readOnly: true,
      inputShape: { invoiceId: z.number().int().positive() },
      run: (input) => readOne(client, 'account.move', input.invoiceId as number, INVOICE_FIELDS),
    },
    {
      name: 'timesheet_create',
      description: 'Crée une ligne d’heures sur un projet (et une tâche optionnelle).',
      readOnly: false,
      inputShape: {
        projectId: z.number().int().positive(),
        taskId: z.number().int().positive().optional(),
        date: z.string(),
        hours: z.number(),
        description: z.string(),
      },
      run: async (input) => {
        const { projectId, taskId, date, hours, description } = input as unknown as TimesheetCreateInput;
        if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_TIMESHEET_HOURS) {
          throw new OdooToolError(
            `Heures invalides : ${hours} (attendu entre 0 exclu et ${MAX_TIMESHEET_HOURS})`,
          );
        }
        if (!DATE_PATTERN.test(date)) {
          throw new OdooToolError(`Date invalide : ${date} (attendu YYYY-MM-DD)`);
        }
        const created = await client.executeKw(
          'account.analytic.line',
          'create',
          [
            {
              project_id: projectId,
              ...(taskId === undefined ? {} : { task_id: taskId }),
              date,
              unit_amount: hours,
              name: description,
            },
          ],
          {},
          z.union([z.number(), z.array(z.number()).nonempty()]),
        );
        return { id: Array.isArray(created) ? created[0] : created };
      },
    },
    {
      name: 'task_update_stage',
      description: 'Change l’étape d’une tâche.',
      readOnly: false,
      inputShape: { taskId: z.number().int().positive(), stageId: z.number().int().positive() },
      run: async (input) => {
        const { taskId, stageId } = input as unknown as TaskUpdateStageInput;
        const ok = await client.executeKw(
          'project.task',
          'write',
          [[taskId], { stage_id: stageId }],
          {},
          z.boolean(),
        );
        return { ok };
      },
    },
  ];
}

export function toToolResult(outcome: { value: unknown } | { error: unknown }): ToolCallResult {
  if ('error' in outcome) {
    const { error } = outcome;
    const message = error instanceof Error ? error.message : String(error);
    const prefix =
      error instanceof OdooRpcError && MODEL_MISSING_PATTERN.test(message)
        ? `${MODEL_MISSING_PREFIX} : `
        : '';
    return { isError: true, content: [{ type: 'text', text: `${prefix}${message}` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(outcome.value) }] };
}

export async function runOdooTool(tool: OdooTool, input: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    return toToolResult({ value: await tool.run(input) });
  } catch (error) {
    return toToolResult({ error });
  }
}
