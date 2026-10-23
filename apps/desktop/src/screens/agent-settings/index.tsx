import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Agent } from '@regis/shared';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import { PageHeader } from '../../components/ui/PageHeader';
import { Tabs } from '../../components/ui/Tabs';
import { tabPanelProps } from '../../components/ui/tab-panel';
import { errorMessage } from '../../lib/format';
import { invokeCmd } from '../../lib/ipc';
import styles from './agents.module.css';
import { AgentsTab } from './AgentsTab';
import { PolicySection } from './PolicySection';
import { RoutingSection } from './RoutingSection';

type TabId = 'agents' | 'routage' | 'politique';

const TABS: { id: TabId; label: string }[] = [
  { id: 'agents', label: 'Agents & comptes' },
  { id: 'routage', label: 'Routage' },
  { id: 'politique', label: 'Politique des outils' },
];

const TAB_PARAM = 'onglet';
const AGENT_PARAM = 'agent';
const ID_PREFIX = 'agent-settings';

function readTab(value: string | null): TabId {
  return TABS.find((entry) => entry.id === value)?.id ?? 'agents';
}

export default function AgentSettingsScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = readTab(searchParams.get(TAB_PARAM));
  const setTab = (next: TabId) => setSearchParams({ [TAB_PARAM]: next }, { replace: true });
  const policyAgentId = searchParams.get(AGENT_PARAM) ?? '';
  const setPolicyAgentId = (agentId: string) =>
    setSearchParams(
      agentId === '' ? { [TAB_PARAM]: 'politique' } : { [TAB_PARAM]: 'politique', [AGENT_PARAM]: agentId },
      { replace: true },
    );
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = useCallback(
    () =>
      invokeCmd<Agent[]>('list_agents').then((loadedAgents) => {
        setAgents(loadedAgents);
        setLoaded(true);
        setError(null);
      }),
    [],
  );

  useEffect(() => {
    loadAgents().catch((reason: unknown) => setError(errorMessage(reason)));
  }, [loadAgents]);

  const ready = loaded || error !== null;
  const policyAgent = agents.find((agent) => agent.id === policyAgentId) ?? null;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Agents & routage"
        subtitle="Un agent = un runtime + un compte + un mode de pilotage + des outils autorisés."
      />

      <Tabs idPrefix={ID_PREFIX} label="Réglages des agents" items={TABS} value={tab} onChange={setTab} />

      <ErrorMessage>{error}</ErrorMessage>
      {!loaded && !error && <Loading />}

      {ready && tab === 'agents' && (
        <div {...tabPanelProps(ID_PREFIX, 'agents')}>
          <AgentsTab agents={agents} onAgentsChange={loadAgents} />
        </div>
      )}

      {ready && tab === 'routage' && (
        <div {...tabPanelProps(ID_PREFIX, 'routage')}>
          <RoutingSection agents={agents} />
        </div>
      )}

      {ready && tab === 'politique' && (
        <div {...tabPanelProps(ID_PREFIX, 'politique')} className={styles.page}>
          <label className={styles.scopePicker}>
            <span>Surcharger pour l’agent</span>
            <select
              className={styles.select}
              value={policyAgentId}
              onChange={(event) => setPolicyAgentId(event.target.value)}
            >
              <option value="">Aucun (politique par défaut)</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <PolicySection key={policyAgentId} agent={policyAgent} defaultAgentScope={policyAgent !== null} />
        </div>
      )}
    </div>
  );
}
