import { z } from 'zod';

export type VariableSource = 'brain' | 'odoo' | 'agent' | 'ask';

export interface TemplateVariable {
  key: string;
  source: VariableSource;
}

const BRAIN_PREFIXES = ['client.', 'contact.'];
const ODOO_PREFIXES = ['projet.'];

export const VARIABLE_SOURCES = ['brain', 'odoo', 'agent', 'ask'] as const;

const storedVariables = z.array(z.object({ key: z.string().min(1), source: z.enum(VARIABLE_SOURCES) }));

export function suggestSource(key: string): VariableSource {
  if (BRAIN_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return 'brain';
  }
  if (ODOO_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return 'odoo';
  }
  return 'agent';
}

export function parseStoredVariables(raw: unknown): TemplateVariable[] {
  const parsed = storedVariables.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function mergeVariables(existing: unknown, detectedKeys: string[]): TemplateVariable[] {
  const declared = new Map(parseStoredVariables(existing).map((variable) => [variable.key, variable.source]));
  return detectedKeys.map((key) => ({ key, source: declared.get(key) ?? suggestSource(key) }));
}
