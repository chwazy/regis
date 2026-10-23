import type { Item } from '@regis/shared';

export type MeetingProvider = 'teams' | 'other';
export interface MeetingJoinInfo {
  url: string;
  provider: MeetingProvider;
  host: string;
}

const TEAMS_PROVIDER = 'teamsForBusiness';
const TEAMS_HOSTS = ['teams.microsoft.com', 'teams.live.com'];

interface EventFields {
  isCancelled?: unknown;
  onlineMeetingUrl?: unknown;
  onlineMeetingProvider?: unknown;
  end?: unknown;
}

function eventFields(event: Item): EventFields {
  return typeof event.dataJson === 'object' && event.dataJson !== null ? (event.dataJson as EventFields) : {};
}

export function meetingJoinInfo(event: Item): MeetingJoinInfo | null {
  if (event.kind !== 'event') {
    return null;
  }
  const data = eventFields(event);
  if (data.isCancelled === true || typeof data.onlineMeetingUrl !== 'string') {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(data.onlineMeetingUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') {
    return null;
  }
  const isTeams = data.onlineMeetingProvider === TEAMS_PROVIDER || TEAMS_HOSTS.includes(parsed.hostname);
  return { url: parsed.href, provider: isTeams ? 'teams' : 'other', host: parsed.hostname };
}

export function canJoin(event: Item, now: Date): boolean {
  if (meetingJoinInfo(event) === null) {
    return false;
  }
  const end = Date.parse(String(eventFields(event).end));
  return Number.isFinite(end) && now.getTime() <= end;
}
