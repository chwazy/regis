import { describe, expect, it } from 'vitest';
import {
  approvalSummary,
  approvalTitle,
  parseEditedInput,
  readApprovalPreview,
  readPreview,
  shortToolName,
  waitingSince,
} from './approval-labels';

describe('approval labels', () => {
  it('shortens qualified tool names', () => {
    expect(shortToolName('mcp__m365__send-mail')).toBe('send-mail');
    expect(shortToolName('Bash')).toBe('Bash');
  });

  it('reads a stored preview and falls back to generic JSON', () => {
    const mail = { kind: 'mail', to: [], subject: 's', body: 'b', attachments: [] };

    expect(readPreview(mail)).toBe(mail);
    expect(readPreview({ a: 1 })).toEqual({ kind: 'generic', json: JSON.stringify({ a: 1 }, null, 2) });
    expect(approvalTitle(readPreview(mail))).toContain('mail');
  });

  it('summarises each preview kind on one line', () => {
    expect(
      approvalSummary(
        {
          kind: 'mail',
          to: ['marc@a.example', 'b@a.example'],
          subject: 'RE: Planning',
          body: '',
          attachments: [],
        },
        'mcp__m365__send-mail',
      ),
    ).toEqual({ action: 'Envoyer un mail à marc@a.example et 1 autre(s)', detail: 'RE: Planning' });
    expect(
      approvalSummary(
        { kind: 'timesheet', project: 'SCADA', date: '2026-10-22', hours: 3.5, description: 'Tags' },
        'mcp__odoo__timesheet_create',
      ),
    ).toEqual({ action: 'Saisir 3h30 sur le projet SCADA', detail: '22 oct. · Tags' });
    expect(approvalSummary({ kind: 'generic', json: '{}' }, 'mcp__fs__write_file')).toEqual({
      action: 'Exécuter write_file',
      detail: '',
    });
  });

  it('describes how long an approval has been waiting', () => {
    const now = new Date('2026-10-22T10:00:00Z');
    expect(waitingSince('2026-10-22T09:59:40Z', now)).toBe('à l’instant');
    expect(waitingSince('2026-10-22T09:52:00Z', now)).toBe('il y a 8 min');
    expect(waitingSince('2026-10-22T07:00:00Z', now)).toBe('il y a 3 h');
    expect(waitingSince('2026-10-19T10:00:00Z', now)).toBe('il y a 3 j');
  });

  it('renders a file write as a file preview instead of escaped JSON', () => {
    const generic = { kind: 'generic', json: '{}' };
    const input = { path: 'notes/a.md', content: 'ligne 1\nligne 2' };
    const preview = readApprovalPreview({ previewJson: generic, inputJson: input });

    expect(preview).toEqual({ kind: 'file', path: 'notes/a.md', content: 'ligne 1\nligne 2' });
    expect(approvalSummary(preview, 'mcp__filesystem__write_file')).toEqual({
      action: 'Écrire le fichier a.md',
      detail: 'notes/a.md',
    });
    expect(approvalTitle(preview)).toContain('fichier');
    expect(readApprovalPreview({ previewJson: generic, inputJson: { path: 'x' } }).kind).toBe('generic');
    expect(readApprovalPreview({ previewJson: generic, inputJson: null }).kind).toBe('generic');
  });

  it('rejects invalid edited JSON', () => {
    expect(parseEditedInput('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseEditedInput('{oops').ok).toBe(false);
  });
});
