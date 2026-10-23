import { z } from 'zod';
import type { Connector, Item, ItemKind, ItemUpsert } from '@regis/shared';
import type { McpHost } from '../mcp/host';
import type { SyncContext, SyncResult, Syncer } from './engine';
import { EventData, MessageData } from './item-schema';

export const M365_TOOLS = {
  listInboxMessages: 'list-mail-folder-messages',
  calendarView: 'get-calendar-view',
} as const;

export const MAIL_WINDOW_DAYS = 14;
export const EVENT_PAST_DAYS = 1;
export const EVENT_FUTURE_DAYS = 14;
export const MAX_MESSAGES_PER_SYNC = 500;
export const MAX_EVENTS_PER_SYNC = 1000;
const PAGE_SIZE = 100;
const MS_PER_DAY = 86_400_000;
const NO_SUBJECT = '(sans objet)';

const MESSAGE_FIELDS = [
  'id',
  'subject',
  'bodyPreview',
  'receivedDateTime',
  'lastModifiedDateTime',
  'from',
  'toRecipients',
  'ccRecipients',
  'isRead',
  'importance',
  'webLink',
  'conversationId',
];
const EVENT_FIELDS = [
  'id',
  'subject',
  'bodyPreview',
  'start',
  'end',
  'isAllDay',
  'isCancelled',
  'lastModifiedDateTime',
  'webLink',
  'location',
  'organizer',
  'attendees',
  'onlineMeeting',
  'onlineMeetingUrl',
  'isOnlineMeeting',
  'onlineMeetingProvider',
];

const emailAddress = z.object({ name: z.string().nullish(), address: z.string().nullish() });
const recipient = z.object({ emailAddress });
const dateTimeZone = z.object({ dateTime: z.string().min(1), timeZone: z.string().nullish() });

const rawMessage = z.object({
  id: z.string().min(1),
  subject: z.string().nullish(),
  bodyPreview: z.string().nullish(),
  receivedDateTime: z.string().min(1),
  lastModifiedDateTime: z.string().nullish(),
  isRead: z.boolean().nullish(),
  importance: z.string().nullish(),
  webLink: z.string().nullish(),
  conversationId: z.string().nullish(),
  from: recipient.nullish(),
  toRecipients: z.array(recipient).nullish(),
  ccRecipients: z.array(recipient).nullish(),
});

const rawEvent = z.object({
  id: z.string().min(1),
  subject: z.string().nullish(),
  bodyPreview: z.string().nullish(),
  start: dateTimeZone,
  end: dateTimeZone,
  isAllDay: z.boolean().nullish(),
  isCancelled: z.boolean().nullish(),
  lastModifiedDateTime: z.string().nullish(),
  webLink: z.string().nullish(),
  location: z.object({ displayName: z.string().nullish() }).nullish(),
  organizer: recipient.nullish(),
  attendees: z
    .array(
      z.object({
        emailAddress,
        type: z.string().nullish(),
        status: z.object({ response: z.string().nullish() }).nullish(),
      }),
    )
    .nullish(),
  onlineMeeting: z.object({ joinUrl: z.string().nullish() }).nullish(),
  onlineMeetingUrl: z.string().nullish(),
  isOnlineMeeting: z.boolean().nullish(),
  onlineMeetingProvider: z.string().nullish(),
});

const graphPage = z.object({ value: z.array(z.unknown()) });

const toolResult = z.object({
  isError: z.boolean().nullish(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
});

interface Person {
  name: string | null;
  address: string | null;
}

function toIso(value: string, timeZone?: string | null): string {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (!hasOffset && timeZone && timeZone.toUpperCase() !== 'UTC') {
    throw new Error(`Unsupported time zone: ${timeZone}`);
  }
  const date = new Date(hasOffset ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date.toISOString();
}

function toPerson(entry: z.infer<typeof recipient>): Person {
  return { name: entry.emailAddress.name ?? null, address: entry.emailAddress.address ?? null };
}

function hasAddress(person: Person): boolean {
  return Boolean(person.address);
}

function toPeople(entries: z.infer<typeof recipient>[] | null | undefined): Person[] {
  return (entries ?? []).map(toPerson).filter(hasAddress);
}

export function mapMessage(raw: unknown, connectorId: string): Item {
  const message = rawMessage.parse(raw);
  const occurredAt = toIso(message.receivedDateTime);
  const from = message.from ? toPerson(message.from) : null;
  const item: Item = {
    id: '',
    connectorId,
    kind: 'message',
    externalId: message.id,
    title: message.subject ? message.subject : NO_SUBJECT,
    bodyText: message.bodyPreview ?? null,
    occurredAt,
    dataJson: {
      from: from && hasAddress(from) ? from : null,
      to: toPeople(message.toRecipients),
      cc: toPeople(message.ccRecipients),
      isRead: message.isRead ?? false,
      importance: message.importance ?? 'normal',
      webLink: message.webLink ?? null,
      conversationId: message.conversationId ?? null,
    },
    updatedAt: message.lastModifiedDateTime ? toIso(message.lastModifiedDateTime) : occurredAt,
  };
  MessageData.parse(item.dataJson);
  return item;
}

export function mapEvent(raw: unknown, connectorId: string): Item {
  const event = rawEvent.parse(raw);
  const occurredAt = toIso(event.start.dateTime, event.start.timeZone);
  const item: Item = {
    id: '',
    connectorId,
    kind: 'event',
    externalId: event.id,
    title: event.subject ? event.subject : NO_SUBJECT,
    bodyText: event.bodyPreview ?? null,
    occurredAt,
    dataJson: {
      end: toIso(event.end.dateTime, event.end.timeZone),
      location: event.location?.displayName || null,
      attendees: (event.attendees ?? [])
        .map((attendee) => ({
          ...toPerson(attendee),
          type: attendee.type ?? null,
          response: attendee.status?.response ?? null,
        }))
        .filter(hasAddress),
      organizer: event.organizer ? toPerson(event.organizer) : null,
      onlineMeetingUrl: event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? null,
      isOnlineMeeting: event.isOnlineMeeting ?? null,
      onlineMeetingProvider: event.onlineMeetingProvider ?? null,
      isAllDay: event.isAllDay ?? false,
      isCancelled: event.isCancelled ?? false,
      webLink: event.webLink ?? null,
    },
    updatedAt: event.lastModifiedDateTime ? toIso(event.lastModifiedDateTime) : occurredAt,
  };
  EventData.parse(item.dataJson);
  return item;
}

export function toUpsert(item: Item): ItemUpsert {
  return {
    connectorId: item.connectorId,
    kind: item.kind,
    externalId: item.externalId,
    title: item.title,
    bodyText: item.bodyText,
    occurredAt: item.occurredAt,
    dataJson: item.dataJson,
    updatedAt: item.updatedAt,
  };
}

export function parseToolPage(result: unknown): unknown[] {
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
  const page = graphPage.safeParse(body);
  if (!page.success) {
    throw new Error('Réponse MCP sans liste « value »');
  }
  return page.data.value;
}

async function fetchMessages(host: McpHost, connectorId: string, since: Date): Promise<unknown[]> {
  const collected: unknown[] = [];
  while (collected.length < MAX_MESSAGES_PER_SYNC) {
    const top = Math.min(PAGE_SIZE, MAX_MESSAGES_PER_SYNC - collected.length);
    const page = parseToolPage(
      await host.callTool(connectorId, M365_TOOLS.listInboxMessages, {
        mailFolderId: 'inbox',
        filter: `receivedDateTime ge ${since.toISOString()}`,
        orderby: 'receivedDateTime desc',
        select: MESSAGE_FIELDS,
        top,
        skip: collected.length,
      }),
    );
    collected.push(...page);
    if (page.length < top) {
      break;
    }
  }
  return collected;
}

async function fetchEvents(host: McpHost, connectorId: string, from: Date, to: Date): Promise<unknown[]> {
  const collected: unknown[] = [];
  while (collected.length < MAX_EVENTS_PER_SYNC) {
    const top = Math.min(PAGE_SIZE, MAX_EVENTS_PER_SYNC - collected.length);
    const page = parseToolPage(
      await host.callTool(connectorId, M365_TOOLS.calendarView, {
        startDateTime: from.toISOString(),
        endDateTime: to.toISOString(),
        timezone: 'UTC',
        orderby: 'start/dateTime',
        select: EVENT_FIELDS,
        top,
        skip: collected.length,
      }),
    );
    collected.push(...page);
    if (page.length < top) {
      return collected;
    }
  }
  console.error(
    `m365 sync: calendar view reached ${MAX_EVENTS_PER_SYNC} events, remaining events were not synced`,
  );
  return collected;
}

export async function syncKind(
  connector: Connector,
  context: SyncContext,
  kind: ItemKind,
  fetchRaw: () => Promise<unknown[]>,
  map: (raw: unknown, connectorId: string) => Item,
): Promise<SyncResult> {
  const startedAt = Date.now();
  try {
    const items: ItemUpsert[] = [];
    let skipped = 0;
    for (const raw of await fetchRaw()) {
      try {
        items.push(toUpsert(map(raw, connector.id)));
      } catch {
        skipped += 1;
      }
    }
    const upserted = items.length > 0 ? await context.store.upsertItems(items) : 0;
    return {
      connectorId: connector.id,
      kind,
      upserted,
      durationMs: Date.now() - startedAt,
      ...(skipped > 0 ? { error: `${skipped} élément(s) ignoré(s) : format inattendu` } : {}),
    };
  } catch (error) {
    return {
      connectorId: connector.id,
      kind,
      upserted: 0,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const m365Syncer: Syncer = {
  connectorKind: 'm365',
  async run(connector, host, _since, context) {
    const now = context.now();
    const messagesSince = new Date(now.getTime() - MAIL_WINDOW_DAYS * MS_PER_DAY);
    const eventsFrom = new Date(now.getTime() - EVENT_PAST_DAYS * MS_PER_DAY);
    const eventsTo = new Date(now.getTime() + EVENT_FUTURE_DAYS * MS_PER_DAY);
    return [
      await syncKind(
        connector,
        context,
        'message',
        () => fetchMessages(host, connector.id, messagesSince),
        mapMessage,
      ),
      await syncKind(
        connector,
        context,
        'event',
        () => fetchEvents(host, connector.id, eventsFrom, eventsTo),
        mapEvent,
      ),
    ];
  },
};
