import type { Approval } from './generated/Approval';
import type { Item } from './generated/Item';
import type { Job } from './generated/Job';

export interface HourSuggestion {
  eventItemId: string;
  projectExternalId: number;
  projectName: string;
  date: string;
  hours: number;
  description: string;
}

export interface BriefData {
  date: string;
  unreadMails: Item[];
  todayEvents: Item[];
  weekHours: { projectName: string; hours: number }[];
  weekTotal: number;
  weekTarget: number;
  overdueInvoices: Item[];
  pendingApprovals: Approval[];
  activeJobs: Job[];
  hourSuggestions: HourSuggestion[];
}

export interface BriefPriority {
  text: string;
  ref?: { type: string; id: string };
}

export interface BriefSections {
  priorities: BriefPriority[];
  quickActions: string[];
}
