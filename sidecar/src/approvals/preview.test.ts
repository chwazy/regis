import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPreview } from './preview';

interface ToolsFixture {
  tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../tests/fixtures/mcp/ms365.tools.json', import.meta.url)),
    'utf8',
  ),
) as ToolsFixture;

describe('buildPreview', () => {
  it('builds a mail preview from the M365 send-mail input shape', () => {
    const sendMail = fixture.tools.find((tool) => tool.name === 'send-mail');
    expect(Object.keys(sendMail?.inputSchema.properties ?? {})).toContain('body');

    const preview = buildPreview('mcp__m365__send-mail', {
      body: {
        Message: {
          subject: 'Offre',
          body: { contentType: 'text', content: 'Bonjour' },
          toRecipients: [{ emailAddress: { address: 'a@example.test' } }],
          ccRecipients: [{ emailAddress: { address: 'b@example.test' } }],
          attachments: [{ name: 'offre.pdf' }],
        },
        SaveToSentItems: true,
      },
    });

    expect(preview).toEqual({
      kind: 'mail',
      to: ['a@example.test'],
      cc: ['b@example.test'],
      subject: 'Offre',
      body: 'Bonjour',
      attachments: ['offre.pdf'],
    });
  });

  it('builds a timesheet preview', () => {
    expect(
      buildPreview('mcp__odoo__timesheet_create', {
        projectId: 3,
        date: '2026-10-21',
        hours: 2.5,
        description: 'x',
      }),
    ).toEqual({ kind: 'timesheet', project: '3', date: '2026-10-21', hours: 2.5, description: 'x' });
  });

  it('falls back to indented JSON for unknown tools and malformed inputs', () => {
    expect(buildPreview('mcp__filesystem__write_file', { path: 'a', content: 'b' })).toEqual({
      kind: 'generic',
      json: JSON.stringify({ path: 'a', content: 'b' }, null, 2),
    });
    expect(buildPreview('mcp__m365__send-mail', { nope: 1 }).kind).toBe('generic');
  });
});
