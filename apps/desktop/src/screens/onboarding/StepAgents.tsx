import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '@regis/shared';
import { invokeCmd, sidecarCall } from '../../lib/ipc';
import { defaultAgentCandidates } from './onboarding-model';
import styles from './onboarding.module.css';

const TEST_TIMEOUT_SECS = 120;

export type DefaultWrite = 'ask' | 'deny';

interface DetectResult {
  claude?: { path: string; version: string };
  ollama?: { url: string; models: string[] };
}

interface TestOutcome {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

interface StepAgentsProps {
  defaultAgentId: string;
  defaultWrite: DefaultWrite;
  onDefaultAgent: (id: string) => void;
  onDefaultWrite: (value: DefaultWrite) => void;
}

function detectLabel(agent: Agent, detect: DetectResult | null): string {
  if (detect === null) {
    return 'Détection en cours…';
  }
  if (agent.runtime === 'claude-cli') {
    return detect.claude ? `CLI Claude trouvée (v${detect.claude.version})` : 'CLI Claude introuvable';
  }
  if (agent.runtime === 'ollama') {
    return detect.ollama
      ? `Ollama joignable (${detect.ollama.models.length} modèle(s))`
      : 'Ollama injoignable';
  }
  if (agent.runtime === 'anthropic-api') {
    return agent.secretRef ? 'Clé API via le coffre de l’OS' : 'Clé API à renseigner dans Agents & comptes';
  }
  return 'Non disponible pour le moment';
}

function testLabel(outcome: TestOutcome): string {
  return outcome.ok
    ? `Test réussi (${outcome.latencyMs} ms)`
    : `Test échoué : ${outcome.error ?? 'erreur inconnue'}`;
}

export function StepAgents({
  defaultAgentId,
  defaultWrite,
  onDefaultAgent,
  onDefaultWrite,
}: StepAgentsProps) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [tests, setTests] = useState<Record<string, TestOutcome | 'running'>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAgents(await invokeCmd<Agent[]>('list_agents'));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  useEffect(() => {
    void load();
    sidecarCall<DetectResult>('agents.detect', {})
      .then(setDetect)
      .catch(() => setDetect({}));
  }, [load]);

  const candidates = defaultAgentCandidates(agents ?? []);
  const candidateIds = candidates.map((agent) => agent.id).join('|');

  useEffect(() => {
    if (agents === null) {
      return;
    }
    const ids = candidateIds === '' ? [] : candidateIds.split('|');
    if (!ids.includes(defaultAgentId)) {
      onDefaultAgent(ids[0] ?? '');
    }
  }, [agents, candidateIds, defaultAgentId, onDefaultAgent]);

  const toggle = async (agent: Agent, enabled: boolean) => {
    try {
      await invokeCmd<Agent>('save_agent', { agent: { ...agent, enabled } });
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  };

  const runTest = async (agent: Agent) => {
    setTests((current) => ({ ...current, [agent.id]: 'running' }));
    try {
      const outcome = await sidecarCall<TestOutcome>('agents.test', { agentId: agent.id }, TEST_TIMEOUT_SECS);
      setTests((current) => ({ ...current, [agent.id]: outcome }));
    } catch (reason) {
      setTests((current) => ({
        ...current,
        [agent.id]: { ok: false, latencyMs: 0, error: String(reason) },
      }));
    }
  };

  return (
    <section className={styles.card} aria-labelledby="onboarding-agents">
      <h2 id="onboarding-agents" className={styles.title}>
        Agents &amp; politique d’écriture
      </h2>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {agents === null ? (
        <p className={styles.hint}>Chargement…</p>
      ) : (
        <div>
          {agents.map((agent) => {
            const test = tests[agent.id];
            return (
              <div key={agent.id} className={styles.agentRow}>
                <div className={styles.agentHead}>
                  <span className={styles.agentName}>{agent.name}</span>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={agent.enabled}
                      onChange={(event) => void toggle(agent, event.target.checked)}
                    />
                    Activé
                  </label>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={test === 'running'}
                    onClick={() => void runTest(agent)}
                  >
                    Tester
                  </button>
                </div>
                <span className={styles.hint}>{detectLabel(agent, detect)}</span>
                {test !== undefined && (
                  <span role="status" className={test !== 'running' && test.ok ? styles.ok : styles.hint}>
                    {test === 'running' ? 'Test en cours…' : testLabel(test)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className={styles.field}>
        <label htmlFor="onboarding-default-agent" className={styles.label}>
          Agent par défaut
        </label>
        <select
          id="onboarding-default-agent"
          className={styles.select}
          value={defaultAgentId}
          disabled={candidates.length === 0}
          onChange={(event) => onDefaultAgent(event.target.value)}
        >
          {candidates.length === 0 && <option value="">Aucun agent activé</option>}
          {candidates.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor="onboarding-default-write" className={styles.label}>
          Écritures non réglées
        </label>
        <select
          id="onboarding-default-write"
          className={styles.select}
          value={defaultWrite}
          onChange={(event) => onDefaultWrite(event.target.value === 'deny' ? 'deny' : 'ask')}
        >
          <option value="ask">Demander (recommandé)</option>
          <option value="deny">Interdire</option>
        </select>
        <span className={styles.hint}>
          S’applique aux outils d’écriture sans règle explicite. Les règles de la politique des outils gardent
          la priorité.
        </span>
      </div>
    </section>
  );
}
