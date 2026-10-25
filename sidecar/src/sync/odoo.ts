import { z } from 'zod';
import type { Item, ItemKind } from '@regis/shared';
import { calendarDay } from '../calendar-day';
import type { McpHost } from '../mcp/host';
import {
  DEFAULT_INVOICE_DAYS,
  DEFAULT_TIME_ZONE,
  DEFAULT_TIMESHEET_DAYS,
  MODEL_MISSING_PREFIX,
} from '../connectors/odoo-mcp/tools';
import type { Syncer } from './engine';
import { syncKind } from './m365';

export const ODOO_TOOLS = {
  partners: 'partner_search',
  projects: 'project_list',
  tasks: 'task_list',
  timesheets: 'timesheet_list',
  invoices: 'invoice_list',
} as const;

export const ODOO_SYNC_LIMIT = 500;
const NO_NAME = '(sans nom)';
const NO_DESCRIPTION = '(sans description)';
const UNPAID_EXEMPT_STATES = new Set(['paid', 'in_payment', 'reversed']);

const emptyField = z.literal(false).transform(() => null);
const optionalText = z.union([z.string(), emptyField]).nullish();
const optionalNumber = z.union([z.number(), emptyField]).nullish();
const many2one = z.union([z.tuple([z.number(), z.string()]), emptyField]).nullish();

const rawPartner = z.object({
  id: z.number(),
  name: optionalText,
  email: optionalText,
  phone: optionalText,
  is_company: z.boolean().nullish(),
  parent_id: many2one,
  write_date: optionalText,
});

const rawProject = z.object({
  id: z.number(),
  name: optionalText,
  partner_id: many2one,
  user_id: many2one,
  date_start: optionalText,
  date: optionalText,
  description: optionalText,
  write_date: optionalText,
});

const rawTask = z.object({
  id: z.number(),
  name: optionalText,
  project_id: many2one,
  stage_id: many2one,
  partner_id: many2one,
  date_deadline: optionalText,
  priority: optionalText,
  state: optionalText,
  description: optionalText,
  write_date: optionalText,
});

const rawTimesheet = z.object({
  id: z.number(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: optionalText,
  unit_amount: optionalNumber,
  project_id: many2one,
  task_id: many2one,
  write_date: optionalText,
});

const rawInvoice = z.object({
  id: z.number(),
  name: optionalText,
  partner_id: many2one,
  invoice_date: optionalText,
  invoice_date_due: optionalText,
  amount_total: optionalNumber,
  currency_id: many2one,
  payment_state: optionalText,
  state: optionalText,
  write_date: optionalText,
});

const toolResult = z.object({
  isError: z.boolean().nullish(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
});

interface Reference {
  id: number;
  name: string;
}

function reference(value: [number, string] | null | undefined): Reference | null {
  return value ? { id: value[0], name: value[1] } : null;
}

function odooDateTimeToIso(value: string): string {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value.replace(' ', 'T');
  const date = new Date(`${normalized}Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date.toISOString();
}

function updatedAtOf(writeDate: string | null | undefined, fallback: string | null): string {
  if (writeDate) {
    return odooDateTimeToIso(writeDate);
  }
  return fallback ?? new Date(0).toISOString();
}

function plainText(html: string | null | undefined): string | null {
  if (!html) {
    return null;
  }
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

function itemOf(
  connectorId: string,
  kind: ItemKind,
  id: number,
  fields: Pick<Item, 'title' | 'bodyText' | 'occurredAt' | 'dataJson' | 'updatedAt'>,
): Item {
  return { id: '', connectorId, kind, externalId: String(id), ...fields };
}

export function mapPartner(raw: unknown, connectorId: string): Item {
  const partner = rawPartner.parse(raw);
  return itemOf(connectorId, 'partner', partner.id, {
    title: partner.name || NO_NAME,
    bodyText: null,
    occurredAt: null,
    dataJson: {
      email: partner.email ?? null,
      phone: partner.phone ?? null,
      isCompany: partner.is_company ?? false,
      parent: reference(partner.parent_id),
    },
    updatedAt: updatedAtOf(partner.write_date, null),
  });
}

export function mapProject(raw: unknown, connectorId: string): Item {
  const project = rawProject.parse(raw);
  return itemOf(connectorId, 'project', project.id, {
    title: project.name || NO_NAME,
    bodyText: plainText(project.description),
    occurredAt: project.date_start ? odooDateTimeToIso(project.date_start) : null,
    dataJson: {
      partner: reference(project.partner_id),
      manager: reference(project.user_id),
      dateStart: project.date_start || null,
      dateEnd: project.date || null,
    },
    updatedAt: updatedAtOf(project.write_date, null),
  });
}

export function mapTask(raw: unknown, connectorId: string): Item {
  const task = rawTask.parse(raw);
  const deadline = task.date_deadline ? odooDateTimeToIso(task.date_deadline) : null;
  return itemOf(connectorId, 'task', task.id, {
    title: task.name || NO_NAME,
    bodyText: plainText(task.description),
    occurredAt: deadline,
    dataJson: {
      project: reference(task.project_id),
      stage: reference(task.stage_id),
      partner: reference(task.partner_id),
      priority: task.priority ?? null,
      state: task.state ?? null,
    },
    updatedAt: updatedAtOf(task.write_date, deadline),
  });
}

export function mapTimesheet(raw: unknown, connectorId: string): Item {
  const line = rawTimesheet.parse(raw);
  return itemOf(connectorId, 'time_entry', line.id, {
    title: line.name || NO_DESCRIPTION,
    bodyText: null,
    occurredAt: line.date,
    dataJson: {
      hours: line.unit_amount ?? 0,
      project: reference(line.project_id),
      task: reference(line.task_id),
    },
    updatedAt: updatedAtOf(line.write_date, odooDateTimeToIso(line.date)),
  });
}

export function todayIn(timeZone: string, now: Date): string {
  return calendarDay(now, timeZone);
}

export function mapInvoice(
  raw: unknown,
  connectorId: string,
  today: string = todayIn(DEFAULT_TIME_ZONE, new Date()),
): Item {
  const invoice = rawInvoice.parse(raw);
  const dueDate = invoice.invoice_date_due || null;
  const paymentState = invoice.payment_state ?? null;
  const overdue =
    dueDate !== null && dueDate < today && !(paymentState !== null && UNPAID_EXEMPT_STATES.has(paymentState));
  return itemOf(connectorId, 'invoice', invoice.id, {
    title: invoice.name || NO_NAME,
    bodyText: null,
    occurredAt: invoice.invoice_date || null,
    dataJson: {
      partner: reference(invoice.partner_id),
      dueDate,
      amountTotal: invoice.amount_total ?? 0,
      currency: reference(invoice.currency_id),
      paymentState,
      state: invoice.state ?? null,
      overdue,
    },
    updatedAt: updatedAtOf(invoice.write_date, null),
  });
}

function parseToolRecords(result: unknown): unknown[] {
  const parsed = toolResult.safeParse(result);
  if (!parsed.success) {
    throw new Error('Réponse MCP illisible');
  }
  const text = parsed.data.content.map((block) => block.text ?? '').join('');
  if (parsed.data.isError) {
    throw new Error(text || 'Outil MCP en erreur');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Réponse MCP illisible : ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(body)) {
    throw new Error('Réponse MCP sans liste');
  }
  return body;
}

async function fetchRecords(
  host: McpHost,
  connectorId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown[]> {
  return parseToolRecords(await host.callTool(connectorId, tool, { limit: ODOO_SYNC_LIMIT, ...args }));
}

export const odooSyncer: Syncer = {
  connectorKind: 'odoo',
  async run(connector, host, _since, context) {
    const today = todayIn(DEFAULT_TIME_ZONE, context.now());
    const fetchTimesheets = async (): Promise<unknown[]> => {
      try {
        return await fetchRecords(host, connector.id, ODOO_TOOLS.timesheets, {
          days: DEFAULT_TIMESHEET_DAYS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes(MODEL_MISSING_PREFIX)) {
          console.error(`[sync:${connector.name}] module Timesheets absent, heures ignorées : ${message}`);
          return [];
        }
        throw error;
      }
    };
    return [
      await syncKind(
        connector,
        context,
        'partner',
        () => fetchRecords(host, connector.id, ODOO_TOOLS.partners, {}),
        mapPartner,
      ),
      await syncKind(
        connector,
        context,
        'project',
        () => fetchRecords(host, connector.id, ODOO_TOOLS.projects, {}),
        mapProject,
      ),
      await syncKind(
        connector,
        context,
        'task',
        () => fetchRecords(host, connector.id, ODOO_TOOLS.tasks, {}),
        mapTask,
      ),
      await syncKind(connector, context, 'time_entry', fetchTimesheets, mapTimesheet),
      await syncKind(
        connector,
        context,
        'invoice',
        () => fetchRecords(host, connector.id, ODOO_TOOLS.invoices, { days: DEFAULT_INVOICE_DAYS }),
        (raw, connectorId) => mapInvoice(raw, connectorId, today),
      ),
    ];
  },
};
