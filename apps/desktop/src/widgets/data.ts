export interface InboxData {
  unread: number;
  priority: number;
  awaitingReply: number;
}

export interface HoursByProjectData {
  weekStart: string;
  total: number;
  projects: { projectName: string; hours: number }[];
}

export interface WeekAgendaData {
  count: number;
  events: { id: string; title: string; startsAt: string | null; location: string | null }[];
}

export interface OdooTasksData {
  count: number;
  tasks: { id: string; title: string; dueDate: string | null }[];
}

export interface InvoicesData {
  overdue: number;
  toIssue: number;
  paidThisMonth: number;
  outstandingAmount: number;
  currency: string | null;
}

export interface JobsData {
  activeCount: number;
  active: { id: string; title: string; status: string }[];
  costTodayUsd: number;
}

export interface RecentFilesData {
  files: { id: string; relPath: string; role: string; modifiedAt: string }[];
}

export interface EntityQueryData {
  days: number;
  count: number;
  entities: { id: string; name: string; lastContact: string | null }[];
}
