import type { PrereqItem, PrereqReport } from '@regis/shared';
import type { DetectResult } from '../rpc/handlers/agents';

export interface PrereqDeps {
  detect: () => Promise<DetectResult>;
  wordAvailable: () => Promise<boolean>;
  now: () => Date;
}

export function hasModel(models: string[], name: string): boolean {
  return models.some((model) => model === name || model.startsWith(`${name}:`));
}

export async function checkPrereqs(deps: PrereqDeps): Promise<PrereqReport> {
  const [detected, word] = await Promise.all([deps.detect(), deps.wordAvailable()]);
  const models = detected.ollama?.models ?? [];

  const ollama: PrereqItem = detected.ollama
    ? {
        id: 'ollama',
        label: 'Ollama',
        required: false,
        state: 'ok',
        detail: `${detected.ollama.url} (${String(models.length)} modèle(s))`,
        help: null,
      }
    : {
        id: 'ollama',
        label: 'Ollama',
        required: false,
        state: 'unreachable',
        detail: 'Ollama est injoignable',
        help: 'Optionnel : installez Ollama depuis https://ollama.com/download puis lancez-le pour la recherche sémantique et l’agent de chat local.',
      };

  const claude: PrereqItem = detected.claude
    ? {
        id: 'claudeCli',
        label: 'CLI Claude Code',
        required: false,
        state: 'ok',
        detail: `${detected.claude.version} (${detected.claude.path})`,
        help: null,
      }
    : {
        id: 'claudeCli',
        label: 'CLI Claude Code',
        required: false,
        state: 'missing',
        detail: 'CLI introuvable',
        help: 'npm install -g @anthropic-ai/claude-code',
      };

  const wordPdf: PrereqItem = word
    ? {
        id: 'wordPdf',
        label: 'Microsoft Word (export PDF)',
        required: false,
        state: 'ok',
        detail: 'Word détecté : export PDF des modèles disponible',
        help: null,
      }
    : {
        id: 'wordPdf',
        label: 'Microsoft Word (export PDF)',
        required: false,
        state: 'missing',
        detail: 'Word introuvable : les modèles sont générés en DOCX seulement',
        help: 'Optionnel : installez Microsoft Word (Windows) pour exporter les documents générés en PDF.',
      };

  return {
    items: [ollama, claude, wordPdf],
    ollamaModels: models,
    checkedAt: deps.now().toISOString(),
  };
}
