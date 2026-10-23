import type { Approval, Item, ItemKind, Link } from '@regis/shared';

let counter = 0;

export function makeItem(kind: ItemKind, overrides: Partial<Item> = {}): Item {
  counter += 1;
  return {
    id: `item-${String(counter)}`,
    connectorId: 'c1',
    kind,
    externalId: String(counter),
    title: `${kind} ${String(counter)}`,
    bodyText: null,
    occurredAt: null,
    dataJson: {},
    updatedAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
}

export function makeMail(overrides: Partial<Item> & { isRead?: boolean } = {}): Item {
  const { isRead = false, ...rest } = overrides;
  return makeItem('message', {
    occurredAt: '2026-10-22T05:00:00.000Z',
    dataJson: { from: { name: 'Alice', address: 'alice@example.com' }, to: [], isRead },
    ...rest,
  });
}

export function makeEvent(start: string, end: string, overrides: Partial<Item> = {}): Item {
  return makeItem('event', {
    occurredAt: start,
    dataJson: { end, attendees: [] },
    ...overrides,
  });
}

export function makeProject(externalId: number, title: string): Item {
  return makeItem('project', { externalId: String(externalId), title });
}

export function makeTimeEntry(date: string, hours: number, project: { id: number; name: string }): Item {
  return makeItem('time_entry', { occurredAt: date, dataJson: { hours, project } });
}

export function makeLink(fromId: string, toId: string): Link {
  return {
    id: `link-${fromId}-${toId}`,
    fromType: 'item',
    fromId,
    toType: 'item',
    toId,
    rel: 'belongs_to',
    origin: 'user',
    confidence: null,
    createdAt: '2026-10-22T00:00:00.000Z',
  };
}

export function makeApproval(id: string): Approval {
  return {
    id,
    jobId: 'j1',
    tool: 'mcp__odoo__timesheet_create',
    inputJson: {},
    previewJson: {},
    status: 'pending',
    decisionNote: null,
    createdAt: '2026-10-22T00:00:00.000Z',
    decidedAt: null,
  };
}
