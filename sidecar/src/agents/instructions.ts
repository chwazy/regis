import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const GLOBAL_INSTRUCTIONS_SETTING = 'agents.instructions.global';
export const ORCHESTRATOR_INSTRUCTIONS_SETTING = 'agents.orchestratorInstructions';

export function agentInstructionsSetting(agentId: string): string {
  return `agents.instructions.${agentId}`;
}

export interface InstructionsDeps {
  getSetting: (key: string) => Promise<string | null>;
  readText?: (path: string) => Promise<string>;
}

export class InstructionsError extends Error {}

const isFileReference = (value: string): boolean => !value.includes('\n') && isAbsolute(value);

async function resolveInstructions(raw: string | null, readText: (path: string) => Promise<string>) {
  const value = raw?.trim() ?? '';
  if (value === '') {
    return '';
  }
  if (!isFileReference(value)) {
    return value;
  }
  try {
    return (await readText(value)).trim();
  } catch (error) {
    throw new InstructionsError(
      `Fichier d’instructions illisible : ${value} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export async function loadInstructions(
  deps: InstructionsDeps,
  agentId: string,
  isConversation = false,
): Promise<string[]> {
  const readText = deps.readText ?? ((path: string) => readFile(path, 'utf8'));
  const keys = [
    GLOBAL_INSTRUCTIONS_SETTING,
    ...(isConversation ? [ORCHESTRATOR_INSTRUCTIONS_SETTING] : []),
    agentInstructionsSetting(agentId),
  ];
  const parts = await Promise.all(
    keys.map((key) => deps.getSetting(key).then((raw) => resolveInstructions(raw, readText))),
  );
  return parts.filter((part) => part !== '');
}

export function composeSystemPrompt(base: string | undefined, instructions: string[]): string | undefined {
  const parts = [base ?? '', ...instructions].filter((part) => part.trim() !== '');
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
