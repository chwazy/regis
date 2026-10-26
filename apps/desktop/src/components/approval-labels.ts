import type { ApprovalPreview } from '@regis/shared';
import { formatCalendarDay, formatHours } from '../lib/format';
import { ASK_USER_QUESTION_TOOL } from './user-question';

const TOOL_SEGMENTS_TO_SKIP = 2;

/** Aperçu « fichier » : construit côté front à partir de l'entrée d'un outil d'écriture. */
export interface FilePreview {
  kind: 'file';
  path: string;
  content: string;
}

export type ViewPreview = ApprovalPreview | FilePreview;

export function approvalTitle(preview: ViewPreview): string {
  switch (preview.kind) {
    case 'file':
      return 'L’agent veut écrire un fichier';
    case 'mail':
      return 'L’agent veut envoyer un mail';
    case 'timesheet':
      return 'L’agent veut saisir des heures';
    case 'generic':
      return 'L’agent demande une validation';
  }
}

export function approvalHeading(approval: {
  tool: string;
  previewJson: unknown;
  inputJson: unknown;
}): string {
  return approval.tool === ASK_USER_QUESTION_TOOL
    ? 'L’agent te pose une question'
    : approvalTitle(readApprovalPreview(approval));
}

export function shortToolName(qualifiedTool: string): string {
  const parts = qualifiedTool.split('__');
  return parts.length > TOOL_SEGMENTS_TO_SKIP ? parts.slice(TOOL_SEGMENTS_TO_SKIP).join('__') : qualifiedTool;
}

export function readPreview(previewJson: unknown): ApprovalPreview {
  if (typeof previewJson === 'object' && previewJson !== null && 'kind' in previewJson) {
    const kind = (previewJson as { kind: unknown }).kind;
    if (kind === 'mail' || kind === 'timesheet' || kind === 'generic') {
      return previewJson as ApprovalPreview;
    }
  }
  return { kind: 'generic', json: JSON.stringify(previewJson ?? {}, null, 2) };
}

/** `{ path, content }` (ou `file_path`) → aperçu fichier ; null pour toute autre entrée. */
export function fileInput(input: unknown): FilePreview | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path : record.file_path;
  if (typeof path !== 'string' || typeof record.content !== 'string') {
    return null;
  }
  return { kind: 'file', path, content: record.content };
}

/**
 * Aperçu à afficher : celui stocké, sauf pour un aperçu générique dont l'entrée est un fichier
 * à écrire (`write_file`, `{ path, content }`), rendu en texte plutôt qu'en JSON échappé.
 */
export function readApprovalPreview(approval: { previewJson: unknown; inputJson: unknown }): ViewPreview {
  const preview = readPreview(approval.previewJson);
  if (preview.kind === 'generic') {
    return fileInput(approval.inputJson) ?? preview;
  }
  return preview;
}

export type EditParseResult = { ok: true; value: unknown } | { ok: false; error: string };

export function parseEditedInput(text: string): EditParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'Le JSON saisi est invalide.' };
  }
}

export interface ApprovalSummary {
  action: string;
  detail: string;
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

function recipientsLabel(to: string[]): string {
  const [first, ...others] = to;
  if (!first) {
    return 'sans destinataire';
  }
  return others.length > 0 ? `à ${first} et ${String(others.length)} autre(s)` : `à ${first}`;
}

function baseName(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? path;
}

export function approvalSummary(preview: ViewPreview, qualifiedTool: string): ApprovalSummary {
  switch (preview.kind) {
    case 'file':
      return { action: `Écrire le fichier ${baseName(preview.path)}`, detail: preview.path };
    case 'mail':
      return {
        action: `Envoyer un mail ${recipientsLabel(preview.to)}`,
        detail: preview.subject || '(sans objet)',
      };
    case 'timesheet':
      return {
        action: `Saisir ${formatHours(preview.hours)} sur le projet ${preview.project}`,
        detail: preview.description
          ? `${formatCalendarDay(preview.date)} · ${preview.description}`
          : formatCalendarDay(preview.date),
      };
    case 'generic':
      return { action: `Exécuter ${shortToolName(qualifiedTool)}`, detail: '' };
  }
}

export function waitingSince(createdAt: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(createdAt)) / MS_PER_MINUTE);
  if (Number.isNaN(minutes) || minutes < 1) {
    return 'à l’instant';
  }
  if (minutes < MINUTES_PER_HOUR) {
    return `il y a ${String(minutes)} min`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return `il y a ${String(hours)} h`;
  }
  return `il y a ${String(Math.floor(hours / HOURS_PER_DAY))} j`;
}
