import { useCallback, useEffect, useState } from 'react';
import type { Agent, PrereqItem, PrereqReport, PrereqState } from '@regis/shared';
import { LocalModuleRow } from '../../components/LocalModuleRow';
import { invokeCmd, sidecarCall } from '../../lib/ipc';
import { useLocalModules } from '../../lib/use-local-modules';
import styles from './onboarding.module.css';

const STATE_LABELS: Record<PrereqState, string> = {
  ok: 'OK',
  missing: 'Absent',
  unreachable: 'Injoignable',
};

interface StepPrereqsProps {
  brainVisible: boolean;
}

export function StepPrereqs({ brainVisible }: StepPrereqsProps) {
  const [report, setReport] = useState<PrereqReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [ollamaAgent, setOllamaAgent] = useState<Agent | null>(null);
  const { modules } = useLocalModules();

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setReport(await sidecarCall<PrereqReport>('prereqs.check', {}));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setChecking(false);
    }
  }, []);

  const loadAgent = useCallback(
    () =>
      invokeCmd<Agent[]>('list_agents')
        .then((agents) => setOllamaAgent(agents.find((agent) => agent.runtime === 'ollama') ?? null))
        .catch(() => setOllamaAgent(null)),
    [],
  );

  useEffect(() => {
    let active = true;
    sidecarCall<PrereqReport>('prereqs.check', {})
      .then((loaded) => active && setReport(loaded))
      .catch((reason: unknown) => active && setError(String(reason)));
    void loadAgent();
    return () => {
      active = false;
    };
  }, [loadAgent]);

  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(text))
      .catch(() => setCopied(null));
  };

  const chooseModel = async (model: string) => {
    if (!ollamaAgent) {
      return;
    }
    try {
      const saved = await invokeCmd<Agent>('save_agent', { agent: { ...ollamaAgent, model } });
      setOllamaAgent(saved);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const isRequired = (item: PrereqItem) => item.required && brainVisible;
  const chatModels = report?.ollamaModels ?? [];

  return (
    <section className={styles.card} aria-labelledby="onboarding-prereqs">
      <h2 id="onboarding-prereqs" className={styles.title}>
        Modules locaux
      </h2>
      <p className={styles.hint}>
        Désactivés par défaut : un module ne s’active qu’une fois son modèle prêt, téléchargé avec votre
        accord. Le téléchargement continue si vous changez d’étape.
      </p>
      {modules.map((module) => (
        <LocalModuleRow key={module.id} module={module} />
      ))}
      <h2 className={styles.title}>Prérequis locaux</h2>
      <p className={styles.hint}>
        Régis ne les installe pas : il les détecte et vous indique la commande à lancer vous-même.
      </p>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {report === null ? (
        <p className={styles.hint}>Vérification en cours…</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Élément</th>
              <th scope="col">État</th>
              <th scope="col">Détail</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {report.items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.label}
                  <br />
                  <span className={styles.hint}>{isRequired(item) ? 'Requis' : 'Optionnel'}</span>
                </td>
                <td>
                  <span className={item.state === 'ok' ? styles.pillOk : styles.pillWarn}>
                    {STATE_LABELS[item.state]}
                  </span>
                </td>
                <td>{item.detail}</td>
                <td>
                  {item.state !== 'ok' && item.help !== null && (
                    <div className={styles.help}>
                      <span className={styles.code}>{item.help}</span>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => copy(item.help ?? '')}
                      >
                        {copied === item.help ? 'Copié' : 'Copier'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={checking}
          onClick={() => void check()}
        >
          Revérifier
        </button>
      </div>
      <div className={styles.field}>
        <label htmlFor="onboarding-chat-model" className={styles.label}>
          Modèle de chat Ollama
        </label>
        <select
          id="onboarding-chat-model"
          className={styles.select}
          value={ollamaAgent?.model ?? ''}
          disabled={ollamaAgent === null || chatModels.length === 0}
          onChange={(event) => void chooseModel(event.target.value)}
        >
          <option value="">{chatModels.length === 0 ? 'Aucun modèle installé' : 'Choisir un modèle'}</option>
          {ollamaAgent?.model && !chatModels.includes(ollamaAgent.model) && (
            <option value={ollamaAgent.model}>{ollamaAgent.model}</option>
          )}
          {chatModels.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <span className={styles.hint}>
          {chatModels.length} modèle(s) installé(s). Le choix est enregistré sur l’agent « Ollama local ».
        </span>
      </div>
    </section>
  );
}
