export type VariableSource = 'brain' | 'odoo' | 'agent' | 'ask';

export interface TemplateVariable {
  key: string;
  source: VariableSource;
}

export const SOURCE_OPTIONS: { value: VariableSource; label: string }[] = [
  { value: 'brain', label: 'Cerveau' },
  { value: 'odoo', label: 'Odoo' },
  { value: 'agent', label: 'Rédigé par l’agent' },
  { value: 'ask', label: 'Demandé à l’utilisateur' },
];

const SOURCE_VALUES = SOURCE_OPTIONS.map((option) => option.value);

function isVariable(value: unknown): value is TemplateVariable {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.key === 'string' && SOURCE_VALUES.includes(candidate.source as VariableSource);
}

export function parseVariables(raw: unknown): TemplateVariable[] {
  return Array.isArray(raw) ? raw.filter(isVariable) : [];
}

export function withSource(
  variables: TemplateVariable[],
  key: string,
  source: VariableSource,
): TemplateVariable[] {
  return variables.map((variable) => (variable.key === key ? { ...variable, source } : variable));
}

export function countLabel(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count > 1 ? plural : singular}`;
}

export function templateKind(ext: string, pdfAvailable: boolean): string {
  const label = ext.toUpperCase() || '—';
  return ext === 'docx' && pdfAvailable ? `${label} → PDF` : label;
}

export function isRenderable(ext: string): boolean {
  return ext === 'docx' || ext === 'md';
}
