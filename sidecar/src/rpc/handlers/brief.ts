import { z } from 'zod';
import { RpcErrorCode, type Brief, type BriefData } from '@regis/shared';
import { calendarDay, TIMEZONE_SETTING } from '../../routing/context';
import { DEFAULT_TIMEZONE } from '../../routing/engine';
import { RpcMethodError, type MethodHandler } from '../server';

const MINUTES_PER_HOUR = 60;

export interface BriefHandlerDeps {
  generate: (now: Date, opts?: { force?: boolean }) => Promise<Brief>;
  getBrief: (date: string) => Promise<Brief | null>;
  collect: (now: Date) => Promise<BriefData>;
  getSetting: (key: string) => Promise<string | null>;
  now?: () => Date;
}

export interface BriefClock {
  date: string;
  minutes: number;
}

const generateParams = z.object({ force: z.boolean().optional() });
const getParams = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
  }
  return parsed.data;
}

export function localClock(now: Date, timezone: string): BriefClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
  return { date: calendarDay(now, timezone), minutes: part('hour') * MINUTES_PER_HOUR + part('minute') };
}

export function createBriefMethods(deps: BriefHandlerDeps): Record<string, MethodHandler> {
  const now = deps.now ?? (() => new Date());
  const timezone = async (): Promise<string> => (await deps.getSetting(TIMEZONE_SETTING)) || DEFAULT_TIMEZONE;
  return {
    'brief.generate': async (params) => {
      const { force } = parseParams(generateParams, params);
      return await deps.generate(now(), force === undefined ? {} : { force });
    },
    'brief.get': async (params) => {
      const { date } = parseParams(getParams, params);
      return await deps.getBrief(date ?? calendarDay(now(), await timezone()));
    },
    'brief.data': async () => await deps.collect(now()),
    'brief.clock': async (): Promise<BriefClock> => localClock(now(), await timezone()),
  };
}
