import { useEffect, useState } from 'react';
import type { Agent, AgentRuntime, Connector, Job } from '@regis/shared';
import { StatusPill } from '../../components/ui/StatusPill';
import { invokeCmd, sidecarCall } from '../../lib/ipc';
import { useTimezone } from '../../lib/use-timezone';
import { agentActivity, type DetectResult } from '../agents/activity';
import {
  AgentEditor,
  type AgentTestOutcome,
  type EditorSettings,
  type EditorSubmission,
} from './AgentEditor';
import {
  agentSubtitle,
  capitalize,
  newAgentDraft,
  secretRefFor,
  stateLabel,
  withRuntime,
} from './agent-labels';
import styles from './agents.module.css';
import { RuntimeBadge } from './RuntimeBadge';
import { RuntimePicker } from './RuntimePicker';

const CLAUDE_BIN_SETTING = 'agents.claudeBin';
const JOBS_LIMIT = 200;

interface AgentsTabProps {
  agents: Agent[];
  onAgentsChange: () => Promise<void>;
}

type Creation = { stage: 'pick'; runtime: AgentRuntime } | { stage: 'edit'; agent: Agent };

export function AgentsTab({ agents, onAgentsChange }: AgentsTabProps) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [pickedId, setSelectedId] = useState<string | null>(null);
  const selectedId = pickedId ?? agents[0]?.id ?? null;
  const [creation, setCreation] = useState<Creation | null>(null);
  const [claudeBin, setClaudeBin] = useState('');
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const timezone = useTimezone();
  const [now] = useState(() => new Date());

  useEffect(() => {
    let active = true;
    invokeCmd<Connector[]>('list_connectors')
      .then((loaded) => active && setConnectors(loaded))
      .catch(() => undefined);
    invokeCmd<string | null>('get_setting', { key: CLAUDE_BIN_SETTING })
      .then((value) => active && setClaudeBin(value ?? ''))
      .catch(() => undefined);
    invokeCmd<Job[]>('list_jobs', { limit: JOBS_LIMIT })
      .then((loaded) => active && setJobs(loaded))
      .catch(() => undefined);
    sidecarCall<DetectResult>('agents.detect', {})
      .then((result) => active && setDetect(result))
      .catch(() => active && setDetect({}));
    return () => {
      active = false;
    };
  }, []);

  const selected =
    creation?.stage === 'edit' ? creation.agent : (agents.find((agent) => agent.id === selectedId) ?? null);
  const detectedClaude = detect?.claude ? `${detect.claude.path} (v${detect.claude.version})` : null;

  const persistSettings = async (settings: EditorSettings) => {
    await invokeCmd('set_setting', { key: CLAUDE_BIN_SETTING, value: settings.claudeBin.trim() });
    setClaudeBin(settings.claudeBin.trim());
  };

  const save = async ({ agent, settings, apiKey }: EditorSubmission): Promise<Agent> => {
    let toSave = agent;
    if (apiKey !== '' && agent.runtime === 'anthropic-api') {
      const secretRef = secretRefFor(agent);
      await invokeCmd('set_secret', { secretRef, value: apiKey });
      toSave = { ...agent, secretRef };
    }
    if (agent.runtime === 'claude-cli') {
      await persistSettings(settings);
    }
    const saved = await invokeCmd<Agent>('save_agent', { agent: toSave });
    setCreation(null);
    setSelectedId(saved.id);
    await onAgentsChange();
    return saved;
  };

  const test = async (agent: Agent, settings: EditorSettings): Promise<AgentTestOutcome> => {
    if (agent.runtime === 'claude-cli') {
      await persistSettings(settings);
    }
    return sidecarCall<AgentTestOutcome>('agents.test', { agentId: agent.id });
  };

  const select = (agentId: string) => {
    setCreation(null);
    setSelectedId(agentId);
  };

  return (
    <div className={styles.masterDetail}>
      <section aria-label="Agents configurés" className={styles.listCard}>
        <ul className={styles.agentList}>
          {agents.map((agent) => {
            const state = stateLabel(agent);
            const isSelected = creation === null && agent.id === selectedId;
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  className={isSelected ? styles.agentItemOn : styles.agentItem}
                  aria-pressed={isSelected}
                  onClick={() => select(agent.id)}
                >
                  <RuntimeBadge runtime={agent.runtime} />
                  <span className={styles.agentItemText}>
                    <span className={styles.agentItemName}>{agent.name}</span>
                    <span className={styles.agentItemSub}>{agentSubtitle(agent)}</span>
                  </span>
                  <StatusPill tone={state.tone === 'ok' ? 'ok' : 'muted'}>
                    {capitalize(state.text)}
                  </StatusPill>
                </button>
              </li>
            );
          })}
          {creation !== null && (
            <li>
              <button type="button" className={styles.agentItemOn} aria-pressed="true">
                <span className={styles.badgeNew} aria-hidden="true">
                  +
                </span>
                <span className={styles.agentItemText}>
                  <span className={styles.agentItemName}>
                    {creation.stage === 'edit' ? creation.agent.name : 'Nouvel agent'}
                  </span>
                  <span className={styles.agentItemSub}>brouillon</span>
                </span>
              </button>
            </li>
          )}
        </ul>
        {agents.length === 0 && creation === null && <p className={styles.empty}>Aucun agent configuré.</p>}
        <div className={styles.listFoot}>
          <button
            type="button"
            className={styles.secondaryButtonWide}
            disabled={creation !== null}
            onClick={() => setCreation({ stage: 'pick', runtime: 'claude-cli' })}
          >
            + Ajouter un agent
          </button>
        </div>
      </section>

      {creation?.stage === 'pick' && (
        <RuntimePicker
          value={creation.runtime}
          detect={detect}
          onChange={(runtime) => setCreation({ stage: 'pick', runtime })}
          onCancel={() => setCreation(null)}
          onContinue={() =>
            setCreation({
              stage: 'edit',
              agent: withRuntime(newAgentDraft(), creation.runtime),
            })
          }
        />
      )}

      {selected && creation?.stage !== 'pick' && (
        <AgentEditor
          key={selected.id === '' ? 'new' : selected.id}
          agent={selected}
          isNew={selected.id === ''}
          connectors={connectors}
          settings={{ claudeBin }}
          detect={detect}
          detectedClaude={detectedClaude}
          activity={selected.id === '' ? null : agentActivity(selected.id, jobs, now, timezone)}
          onSave={save}
          onTest={test}
          onCancelNew={() => setCreation(null)}
        />
      )}
    </div>
  );
}
