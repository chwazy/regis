import { z } from 'zod';
import type { ApprovalPreview } from '@regis/shared';

export type { ApprovalPreview };

const recipient = z.object({ emailAddress: z.object({ address: z.string().nullish() }).nullish() });
const graphMessage = z.object({
  subject: z.string().nullish(),
  body: z.object({ content: z.string().nullish() }).nullish(),
  toRecipients: z.array(recipient).nullish(),
  ccRecipients: z.array(recipient).nullish(),
  attachments: z.array(z.object({ name: z.string().nullish() })).nullish(),
});
const sendMailInput = z.object({ body: z.object({ Message: graphMessage }) });
const timesheetInput = z.object({
  projectId: z.union([z.string(), z.number()]),
  date: z.string(),
  hours: z.number(),
  description: z.string().default(''),
});

function toolName(qualifiedTool: string): string {
  return qualifiedTool.split('__').slice(2).join('__');
}

function addresses(recipients: z.infer<typeof recipient>[] | null | undefined): string[] {
  return (recipients ?? []).flatMap((entry) => {
    const address = entry.emailAddress?.address;
    return address ? [address] : [];
  });
}

function mailPreview(input: unknown): ApprovalPreview | undefined {
  const parsed = sendMailInput.safeParse(input);
  if (!parsed.success) {
    return undefined;
  }
  const message = parsed.data.body.Message;
  const cc = addresses(message.ccRecipients);
  return {
    kind: 'mail',
    to: addresses(message.toRecipients),
    ...(cc.length > 0 ? { cc } : {}),
    subject: message.subject ?? '',
    body: message.body?.content ?? '',
    attachments: (message.attachments ?? []).flatMap((attachment) =>
      attachment.name ? [attachment.name] : [],
    ),
  };
}

function timesheetPreview(input: unknown): ApprovalPreview | undefined {
  const parsed = timesheetInput.safeParse(input);
  if (!parsed.success) {
    return undefined;
  }
  const { projectId, date, hours, description } = parsed.data;
  return { kind: 'timesheet', project: String(projectId), date, hours, description };
}

export function buildPreview(qualifiedTool: string, input: unknown): ApprovalPreview {
  const name = toolName(qualifiedTool);
  const specific = name.includes('send')
    ? mailPreview(input)
    : name === 'timesheet_create'
      ? timesheetPreview(input)
      : undefined;
  return specific ?? { kind: 'generic', json: JSON.stringify(input, null, 2) };
}
