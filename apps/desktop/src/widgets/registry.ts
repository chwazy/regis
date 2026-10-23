import type { FC } from 'react';
import { CustomWidget } from './CustomWidget';
import { EntityQueryWidget } from './EntityQueryWidget';
import { HoursByProjectWidget } from './HoursByProjectWidget';
import { InboxWidget } from './InboxWidget';
import { InvoicesWidget } from './InvoicesWidget';
import { JobsWidget } from './JobsWidget';
import { DEFAULT_MCP_REFRESH_MINUTES, McpToolWidget } from './McpToolWidget';
import { OdooTasksWidget } from './OdooTasksWidget';
import { RecentFilesWidget } from './RecentFilesWidget';
import { WeekAgendaWidget } from './WeekAgendaWidget';

export type WidgetKind =
  | 'inbox'
  | 'hours_by_project'
  | 'week_agenda'
  | 'odoo_tasks'
  | 'invoices'
  | 'jobs'
  | 'recent_files'
  | 'entity_query'
  | 'mcp_tool'
  | 'custom';

export type WidgetSource = 'M365' | 'Odoo' | 'Régis' | 'Cerveau' | 'MCP';

export const WIDGET_SOURCES: readonly WidgetSource[] = ['M365', 'Odoo', 'Régis', 'Cerveau', 'MCP'];

export interface WidgetDefinition<C = unknown> {
  kind: WidgetKind;
  title: string;
  source: WidgetSource;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  defaultConfig: C;
  Component: FC<{ config: C; widgetId: string }>;
}

const CARD_SIZE = { w: 3, h: 4 };
const MIN_CARD_SIZE = { w: 2, h: 3 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WIDGETS: Record<WidgetKind, WidgetDefinition<any>> = {
  inbox: {
    kind: 'inbox',
    title: 'Boîtes de réception',
    source: 'M365',
    defaultSize: CARD_SIZE,
    minSize: MIN_CARD_SIZE,
    defaultConfig: {},
    Component: InboxWidget,
  },
  hours_by_project: {
    kind: 'hours_by_project',
    title: 'Heures par projet',
    source: 'Odoo',
    defaultSize: CARD_SIZE,
    minSize: MIN_CARD_SIZE,
    defaultConfig: {},
    Component: HoursByProjectWidget,
  },
  week_agenda: {
    kind: 'week_agenda',
    title: 'Semaine',
    source: 'M365',
    defaultSize: { w: 6, h: 4 },
    minSize: MIN_CARD_SIZE,
    defaultConfig: {},
    Component: WeekAgendaWidget,
  },
  odoo_tasks: {
    kind: 'odoo_tasks',
    title: 'Tâches Odoo',
    source: 'Odoo',
    defaultSize: CARD_SIZE,
    minSize: MIN_CARD_SIZE,
    defaultConfig: {},
    Component: OdooTasksWidget,
  },
  invoices: {
    kind: 'invoices',
    title: 'Factures',
    source: 'Odoo',
    defaultSize: CARD_SIZE,
    minSize: MIN_CARD_SIZE,
    defaultConfig: {},
    Component: InvoicesWidget,
  },
  jobs: {
    kind: 'jobs',
    title: 'Tâches des agents',
    source: 'Régis',
    defaultSize: CARD_SIZE,
    minSize: MIN_CARD_SIZE,
    defaultConfig: {},
    Component: JobsWidget,
  },
  recent_files: {
    kind: 'recent_files',
    title: 'Fichiers récents',
    source: 'Régis',
    defaultSize: CARD_SIZE,
    minSize: MIN_CARD_SIZE,
    defaultConfig: {},
    Component: RecentFilesWidget,
  },
  entity_query: {
    kind: 'entity_query',
    title: 'Clients sans contact',
    source: 'Cerveau',
    defaultSize: CARD_SIZE,
    minSize: MIN_CARD_SIZE,
    defaultConfig: { days: 30, kind: 'client' },
    Component: EntityQueryWidget,
  },
  mcp_tool: {
    kind: 'mcp_tool',
    title: 'Outil MCP',
    source: 'MCP',
    defaultSize: CARD_SIZE,
    minSize: MIN_CARD_SIZE,
    defaultConfig: { connectorId: '', tool: '', args: {}, refreshMinutes: DEFAULT_MCP_REFRESH_MINUTES },
    Component: McpToolWidget,
  },
  custom: {
    kind: 'custom',
    title: 'Widget sur mesure',
    source: 'Régis',
    defaultSize: CARD_SIZE,
    minSize: MIN_CARD_SIZE,
    defaultConfig: {},
    Component: CustomWidget,
  },
};

export function widgetDefinition(kind: string): WidgetDefinition | undefined {
  return Object.hasOwn(WIDGETS, kind) ? WIDGETS[kind as WidgetKind] : undefined;
}
