import { z } from 'zod';

export const CustomWidgetSpec = z.object({
  title: z.string().max(60),
  itemKind: z.enum(['message', 'event', 'task', 'time_entry', 'invoice', 'project', 'partner']),
  filters: z
    .array(
      z.object({
        field: z.string(),
        op: z.enum(['eq', 'neq', 'gt', 'lt', 'contains', 'within_days']),
        value: z.union([z.string(), z.number(), z.boolean()]),
      }),
    )
    .max(5),
  groupBy: z.string().optional(),
  aggregate: z.object({ fn: z.enum(['count', 'sum']), field: z.string().optional() }),
  render: z.enum(['list', 'kv', 'bar']),
  limit: z.number().int().min(1).max(50).default(10),
});

export type CustomWidgetSpec = z.infer<typeof CustomWidgetSpec>;
export type CustomItemKind = CustomWidgetSpec['itemKind'];

export interface CustomWidgetRow {
  label: string;
  value: number;
}

export interface CustomWidgetData {
  rows: CustomWidgetRow[];
  total: number;
}

export const CUSTOM_COLUMN_FIELDS = ['title', 'bodyText', 'occurredAt', 'updatedAt', 'externalId'] as const;

export const CUSTOM_NUMERIC_FIELDS: readonly string[] = ['data.hours', 'data.amountTotal'];

export const CUSTOM_DATA_FIELDS: Record<CustomItemKind, readonly string[]> = {
  message: ['isRead', 'importance', 'conversationId', 'from.name', 'from.address'],
  event: ['end', 'location', 'isAllDay', 'isCancelled', 'organizer.name', 'organizer.address'],
  task: ['project.name', 'stage.name', 'partner.name', 'priority', 'state'],
  time_entry: ['hours', 'project.name', 'task.name'],
  invoice: ['partner.name', 'dueDate', 'amountTotal', 'currency.name', 'paymentState', 'state', 'overdue'],
  project: ['partner.name', 'manager.name', 'dateStart', 'dateEnd'],
  partner: ['email', 'phone', 'isCompany', 'parent.name'],
};

export const CUSTOM_DATE_FIELDS: readonly string[] = [
  'occurredAt',
  'updatedAt',
  'data.end',
  'data.dueDate',
  'data.dateStart',
  'data.dateEnd',
];

export const CUSTOM_MAX_WITHIN_DAYS = 3660;

export function customFieldsOf(kind: CustomItemKind): string[] {
  return [...CUSTOM_COLUMN_FIELDS, ...CUSTOM_DATA_FIELDS[kind].map((path) => `data.${path}`)];
}

export function customSpecFieldErrors(spec: CustomWidgetSpec): string[] {
  const known = new Set(customFieldsOf(spec.itemKind));
  const used = [
    ...spec.filters.map((filter) => filter.field),
    ...(spec.groupBy === undefined ? [] : [spec.groupBy]),
    ...(spec.aggregate.field === undefined ? [] : [spec.aggregate.field]),
  ];
  const errors = used.filter((field) => !known.has(field)).map((field) => `Champ inconnu : ${field}`);
  for (const filter of spec.filters) {
    errors.push(...customFilterErrors(filter));
  }
  if (spec.aggregate.fn === 'sum') {
    const field = spec.aggregate.field;
    if (field === undefined || !CUSTOM_NUMERIC_FIELDS.includes(field)) {
      errors.push('La somme demande un champ numérique (data.hours, data.amountTotal)');
    }
  }
  return errors;
}

type CustomFilter = CustomWidgetSpec['filters'][number];

function customFilterErrors(filter: CustomFilter): string[] {
  if (filter.op === 'contains' && typeof filter.value === 'boolean') {
    return [`« contient » demande un texte (${filter.field})`];
  }
  if (filter.op !== 'within_days') {
    return [];
  }
  const errors: string[] = [];
  if (!CUSTOM_DATE_FIELDS.includes(filter.field)) {
    errors.push(`« dans les N jours » demande un champ date : ${filter.field}`);
  }
  if (
    typeof filter.value !== 'number' ||
    !Number.isFinite(filter.value) ||
    Math.abs(filter.value) > CUSTOM_MAX_WITHIN_DAYS
  ) {
    errors.push(
      `« dans les N jours » demande un nombre de jours entre -${String(CUSTOM_MAX_WITHIN_DAYS)} et ${String(CUSTOM_MAX_WITHIN_DAYS)}`,
    );
  }
  return errors;
}

export function customWithinDayOffsets(filters: CustomWidgetSpec['filters']): number[] {
  const offsets = new Set<number>();
  for (const filter of filters) {
    if (filter.op === 'within_days' && typeof filter.value === 'number' && Number.isFinite(filter.value)) {
      const span = Math.trunc(filter.value);
      offsets.add(Math.min(0, span));
      offsets.add(Math.max(0, span) + 1);
    }
  }
  return [...offsets];
}
