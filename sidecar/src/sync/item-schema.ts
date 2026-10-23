import { z } from 'zod';

const Person = z.looseObject({ name: z.string().nullish(), address: z.string().min(1) });

export const MessageData = z.looseObject({
  from: Person.nullable(),
  to: z.array(Person),
  isRead: z.boolean(),
  webLink: z.string().nullish(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
});

export const EventData = z.looseObject({
  end: z.iso.datetime(),
  location: z.string().nullish(),
  attendees: z.array(Person),
  onlineMeetingUrl: z.string().nullish(),
  isOnlineMeeting: z.boolean().nullish(),
  onlineMeetingProvider: z.string().nullish(), // 'teamsForBusiness' | 'skypeForBusiness' | 'skypeForConsumer' | 'unknown' selon Graph
});
