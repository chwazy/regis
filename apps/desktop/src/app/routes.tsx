import { Navigate, type RouteObject } from 'react-router';
import { firstVisibleRoute, type ScreenKey } from '../lib/ui-screens';
import { useUiScreens } from '../lib/use-ui-screens';
import AgentSettingsScreen from '../screens/agent-settings';
import AgentsScreen from '../screens/agents';
import BrainScreen from '../screens/brain';
import BriefScreen from '../screens/brief';
import ConnectorsScreen from '../screens/connectors';
import DashboardScreen from '../screens/dashboard';
import JobScreen from '../screens/job';
import OnboardingScreen from '../screens/onboarding';
import SettingsScreen from '../screens/settings';
import SourcesScreen from '../screens/sources';
import TranscriptScreen from '../screens/transcript';
import VoiceSettingsScreen from '../screens/voice';
import { App } from './App';
import { SettingsLayout } from './SettingsLayout';
import { OnboardingGate } from './OnboardingGate';

export const ROUTES = {
  brief: '/',
  dashboard: '/dashboard',
  brain: '/cerveau',
  agents: '/agents',
  job: '/jobs/:jobId',
  transcript: '/transcripts/:itemId',
  sources: '/reglages/modeles-sources',
  connectors: '/reglages/connecteurs',
  settings: '/reglages',
  agentSettings: '/reglages/agents',
  voiceSettings: '/reglages/voix',
  onboarding: '/bienvenue',
} as const;

export const NAV_ITEMS: readonly {
  label: string;
  to: string;
  screen?: ScreenKey;
  also?: readonly string[];
}[] = [
  { label: 'Brief', to: ROUTES.brief, screen: 'brief' },
  { label: 'Dashboard', to: ROUTES.dashboard, screen: 'dashboard' },
  { label: 'Cerveau', to: ROUTES.brain, screen: 'brain', also: ['/transcripts/'] },
  { label: 'Agents', to: ROUTES.agents, also: ['/jobs/'] },
];

export const SETTINGS_ITEMS = [
  { label: 'Général', to: ROUTES.settings },
  { label: 'Agents & routage', to: ROUTES.agentSettings },
  { label: 'Voix & transcription', to: ROUTES.voiceSettings },
  { label: 'Modèles & sources', to: ROUTES.sources },
  { label: 'Connecteurs', to: ROUTES.connectors },
] as const;

function IndexRoute() {
  const { screens, loaded } = useUiScreens();
  if (!loaded) {
    return null;
  }
  return screens.brief ? <BriefScreen /> : <Navigate to={firstVisibleRoute(screens)} replace />;
}

export const routes: RouteObject[] = [
  { path: ROUTES.onboarding, element: <OnboardingScreen /> },
  {
    path: ROUTES.brief,
    element: (
      <OnboardingGate>
        <App />
      </OnboardingGate>
    ),
    children: [
      { index: true, element: <IndexRoute /> },
      { path: ROUTES.dashboard.slice(1), element: <DashboardScreen /> },
      { path: ROUTES.brain.slice(1), element: <BrainScreen /> },
      { path: ROUTES.agents.slice(1), element: <AgentsScreen /> },
      { path: ROUTES.job.slice(1), element: <JobScreen /> },
      { path: ROUTES.transcript.slice(1), element: <TranscriptScreen /> },
      {
        path: ROUTES.settings.slice(1),
        element: <SettingsLayout />,
        children: [
          { index: true, element: <SettingsScreen /> },
          { path: 'agents', element: <AgentSettingsScreen /> },
          { path: 'voix', element: <VoiceSettingsScreen /> },
          { path: 'modeles-sources', element: <SourcesScreen /> },
          { path: 'connecteurs', element: <ConnectorsScreen /> },
        ],
      },
      { path: 'modeles-sources', element: <Navigate to={ROUTES.sources} replace /> },
      { path: 'connecteurs', element: <Navigate to={ROUTES.connectors} replace /> },
    ],
  },
];
