export type ApprovalPreview =
  | { kind: 'mail'; to: string[]; cc?: string[]; subject: string; body: string; attachments: string[] }
  | { kind: 'timesheet'; project: string; date: string; hours: number; description: string }
  | { kind: 'generic'; json: string };
