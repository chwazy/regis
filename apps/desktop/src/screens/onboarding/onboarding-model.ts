import type { UiScreens } from '../../lib/ui-screens';

export type ProfileId = 'complete' | 'pro' | 'brain';
export type ConnectorStepId = 'm365' | 'odoo' | 'files';
export type StepId = 'profile' | 'data' | 'prereqs' | 'connectors' | 'agents' | 'summary';

export interface Profile {
  id: ProfileId;
  label: string;
  description: string;
  screens: UiScreens;
  connectorSteps: ConnectorStepId[];
  showOtherConnectorsHint: boolean;
}

export const PROFILES: readonly Profile[] = [
  {
    id: 'complete',
    label: 'Complet',
    description: 'Brief, Dashboard et Cerveau, avec Microsoft 365, Odoo et vos fichiers.',
    screens: { brief: true, dashboard: true, brain: true },
    connectorSteps: ['m365', 'odoo', 'files'],
    showOtherConnectorsHint: true,
  },
  {
    id: 'pro',
    label: 'Pro (M365 + Odoo)',
    description: 'Brief, Dashboard et Cerveau, centrés sur Microsoft 365 et Odoo.',
    screens: { brief: true, dashboard: true, brain: true },
    connectorSteps: ['m365', 'odoo', 'files'],
    showOtherConnectorsHint: false,
  },
  {
    id: 'brain',
    label: 'Cerveau seul',
    description: 'Seulement le second cerveau, alimenté par vos fichiers.',
    screens: { brief: false, dashboard: false, brain: true },
    connectorSteps: ['files'],
    showOtherConnectorsHint: false,
  },
];

export const STEPS: readonly StepId[] = ['profile', 'data', 'prereqs', 'connectors', 'agents', 'summary'];

export const STEP_LABELS: Record<StepId, string> = {
  profile: 'Profil',
  data: 'Données & fuseau',
  prereqs: 'Prérequis',
  connectors: 'Connecteurs',
  agents: 'Agents & politique',
  summary: 'Récapitulatif',
};

export const ONBOARDING_COMPLETED_KEY = 'onboarding.completedAt';
export const ONBOARDING_PROFILE_KEY = 'onboarding.profile';
export const DEFAULT_AGENT_KEY = 'agents.defaultAgentId';

const DEFAULT_PROFILE_ID: ProfileId = 'complete';

export function profileById(id: string | null): Profile {
  const found = PROFILES.find((profile) => profile.id === id);
  if (found) {
    return found;
  }
  return PROFILES.find((profile) => profile.id === DEFAULT_PROFILE_ID) ?? (PROFILES[0] as Profile);
}

export function shouldShowOnboarding(completedAt: string | null, forceOnboarding: boolean): boolean {
  return forceOnboarding || completedAt === null;
}

export function parseResumeQuery(search: string): { profile: ProfileId | null; step: StepId | null } {
  const params = new URLSearchParams(search);
  const profile = PROFILES.find((candidate) => candidate.id === params.get('profile'))?.id ?? null;
  const step = STEPS.find((candidate) => candidate === params.get('step')) ?? null;
  return { profile, step };
}

/** URL de reprise après changement de dossier : uniquement `profile` et `step`. */
export function buildResumeUrl(profile: ProfileId, step: StepId): string {
  return `/bienvenue?profile=${profile}&step=${step}`;
}

export function defaultAgentCandidates<T extends { id: string; enabled: boolean }>(agents: T[]): T[] {
  return agents.filter((agent) => agent.enabled);
}

export function isKnownTimezone(value: string, available: readonly string[]): boolean {
  return available.includes(value);
}
