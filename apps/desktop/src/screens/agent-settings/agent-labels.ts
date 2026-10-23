import type { Agent, AgentMode, AgentRuntime } from '@regis/shared';
import { formatUsd } from '../../lib/format';

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  description: string;
  available: boolean;
}

export const RUNTIME_OPTIONS: ChoiceOption<AgentRuntime>[] = [
  { value: 'claude-cli', label: 'Claude Code (CLI)', description: 'CLI locale', available: true },
  { value: 'anthropic-api', label: 'API Anthropic', description: 'API cloud', available: true },
  { value: 'ollama', label: 'Ollama', description: 'Modèle local', available: true },
  { value: 'codex-cli', label: 'Codex (CLI)', description: 'CLI locale', available: false },
  { value: 'gemini-cli', label: 'Gemini CLI', description: 'CLI locale', available: false },
];

export const MODE_OPTIONS: ChoiceOption<AgentMode>[] = [
  {
    value: 'headless',
    label: 'Headless — stream-json',
    description:
      'claude -p --output-format stream-json. Statut, coût et outils lus en structuré. Idéal pour les sous-tâches.',
    available: true,
  },
  {
    value: 'api',
    label: 'API',
    description: 'Appels HTTP directs au modèle, sans CLI.',
    available: true,
  },
  {
    value: 'pty',
    label: 'Terminal — PTY',
    description: 'La CLI interactive dans un vrai terminal. Tu peux reprendre la main.',
    available: false,
  },
  {
    value: 'acp',
    label: 'ACP',
    description: 'Agent Client Protocol, si la CLI le supporte. Messages et permissions structurés.',
    available: false,
  },
];

export const PLANNED_TOOLTIP = 'prévu';

const MODE_BY_RUNTIME: Record<AgentRuntime, AgentMode> = {
  'claude-cli': 'headless',
  'anthropic-api': 'api',
  ollama: 'api',
  'codex-cli': 'headless',
  'gemini-cli': 'acp',
};

export function defaultModeFor(runtime: AgentRuntime): AgentMode {
  return MODE_BY_RUNTIME[runtime];
}

export function isModeAllowed(runtime: AgentRuntime, mode: AgentMode): boolean {
  return (
    MODE_OPTIONS.some((option) => option.value === mode && option.available) &&
    MODE_BY_RUNTIME[runtime] === mode
  );
}

export function runtimeLabel(runtime: AgentRuntime): string {
  return RUNTIME_OPTIONS.find((option) => option.value === runtime)?.label ?? runtime;
}

export function capitalize(text: string): string {
  return text === '' ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function runtimeTypeLabel(runtime: AgentRuntime): string {
  return RUNTIME_OPTIONS.find((option) => option.value === runtime)?.description ?? runtime;
}

export function modeLabel(mode: AgentMode): string {
  return MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

export function budgetLabel(agent: Agent): string {
  if (agent.budgetDailyUsd !== null) {
    return formatUsd(agent.budgetDailyUsd, { estimate: false });
  }
  return agent.runtime === 'claude-cli' ? 'quota abo.' : '—';
}

export function stateLabel(agent: Agent): { text: string; tone: 'ok' | 'idle' } {
  const planned = RUNTIME_OPTIONS.find((option) => option.value === agent.runtime)?.available === false;
  if (planned) {
    return { text: 'prévu', tone: 'idle' };
  }
  return agent.enabled ? { text: 'activé', tone: 'ok' } : { text: 'désactivé', tone: 'idle' };
}

export function newAgentDraft(): Agent {
  return {
    id: '',
    name: 'Nouvel agent',
    runtime: 'anthropic-api',
    mode: 'api',
    accountLabel: null,
    model: null,
    budgetDailyUsd: null,
    useWhen: '',
    canSpawn: false,
    worktreePerJob: false,
    connectorIdsJson: [],
    secretRef: null,
    isLocalOnly: false,
    enabled: true,
  };
}

export function withRuntime(agent: Agent, runtime: AgentRuntime): Agent {
  return {
    ...agent,
    runtime,
    mode: defaultModeFor(runtime),
    isLocalOnly: runtime === 'ollama',
  };
}

export function connectorIds(agent: Agent): string[] {
  return Array.isArray(agent.connectorIdsJson) ? agent.connectorIdsJson.map(String) : [];
}

export function toggleConnector(agent: Agent, connectorId: string): Agent {
  const current = connectorIds(agent);
  const next = current.includes(connectorId)
    ? current.filter((id) => id !== connectorId)
    : [...current, connectorId];
  return { ...agent, connectorIdsJson: next };
}

export function secretRefFor(agent: Agent): string {
  return agent.secretRef ?? `agent-api-key-${crypto.randomUUID()}`;
}

export type RuntimeTone = 'cli' | 'api' | 'local' | 'planned';

const RUNTIME_BADGES: Record<AgentRuntime, { initials: string; tone: RuntimeTone }> = {
  'claude-cli': { initials: 'CC', tone: 'cli' },
  'anthropic-api': { initials: 'API', tone: 'api' },
  ollama: { initials: 'OL', tone: 'local' },
  'codex-cli': { initials: 'CX', tone: 'planned' },
  'gemini-cli': { initials: 'GM', tone: 'planned' },
};

export function runtimeBadge(runtime: AgentRuntime): { initials: string; tone: RuntimeTone } {
  return RUNTIME_BADGES[runtime];
}

export const RUNTIME_PITCH: Record<AgentRuntime, string> = {
  'claude-cli':
    'Utilise ta CLI et ton abonnement. Idéal pour le code et les tâches longues. Données envoyées à Anthropic.',
  'anthropic-api': 'Appels directs avec une clé API, facturés à l’usage. Rapide pour le tri et l’extraction.',
  ollama: 'Modèle local, rien ne sort du PC. Pour les données sensibles.',
  'codex-cli': 'Prévu.',
  'gemini-cli': 'Prévu.',
};

export function agentSubtitle(agent: Agent): string {
  const detail =
    agent.budgetDailyUsd !== null
      ? `${formatUsd(agent.budgetDailyUsd, { estimate: false })}/j`
      : agent.runtime === 'claude-cli'
        ? 'abonnement'
        : (agent.model ?? '');
  const type = runtimeTypeLabel(agent.runtime);
  return detail === '' ? type : `${type} · ${detail}`;
}

export interface EditorSnapshot {
  agent: Agent;
  claudeBin: string;
  apiKey: string;
}

export function isEditorDirty(initial: EditorSnapshot, current: EditorSnapshot): boolean {
  return (
    current.apiKey !== '' ||
    current.claudeBin.trim() !== initial.claudeBin.trim() ||
    JSON.stringify(current.agent) !== JSON.stringify(initial.agent)
  );
}
