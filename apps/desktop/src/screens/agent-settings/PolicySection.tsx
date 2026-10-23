import { useCallback, useEffect, useState } from 'react';
import type { Agent, Policy, ToolPolicy } from '@regis/shared';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/format';
import { invokeCmd } from '../../lib/ipc';
import { POLICY_OPTIONS, buildPolicyRows, policyToSave, type PolicyScope } from './policy-rows';
import styles from './policy.module.css';

interface PolicySectionProps {
  agent: Agent | null;
  defaultAgentScope?: boolean;
}

export function PolicySection({ agent, defaultAgentScope = false }: PolicySectionProps) {
  const [policies, setPolicies] = useState<ToolPolicy[]>([]);
  const [useAgentScope, setUseAgentScope] = useState(defaultAgentScope);
  const [newPattern, setNewPattern] = useState('');
  const [error, setError] = useState<string | null>(null);

  const scope: PolicyScope =
    useAgentScope && agent !== null && agent.id !== ''
      ? { kind: 'agent', agentId: agent.id }
      : { kind: 'default' };

  const reload = useCallback(
    () =>
      invokeCmd<ToolPolicy[]>('list_policies')
        .then((loaded) => {
          setPolicies(loaded);
          setError(null);
        })
        .catch((reason: unknown) => setError(errorMessage(reason))),
    [],
  );

  useEffect(() => {
    let active = true;
    invokeCmd<ToolPolicy[]>('list_policies')
      .then((loaded) => active && setPolicies(loaded))
      .catch((reason: unknown) => active && setError(errorMessage(reason)));
    return () => {
      active = false;
    };
  }, []);

  const change = async (pattern: string, policy: Policy) => {
    try {
      await invokeCmd<ToolPolicy>('save_policy', { policy: policyToSave(scope, pattern, policy) });
      await reload();
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    }
  };

  const addPattern = async () => {
    if (newPattern.trim() === '') {
      return;
    }
    await change(newPattern, 'ask');
    setNewPattern('');
  };

  const rows = buildPolicyRows(policies, scope);

  return (
    <section aria-label="Politique des outils" className={styles.card}>
      <div className={styles.head}>
        <h2 className={styles.title}>Politique des outils MCP</h2>
        <span className={styles.caption}>par défaut · surchargeable par agent</span>
      </div>
      {agent !== null && agent.id !== '' && (
        <div className={styles.scope} role="group" aria-label="Portée de la politique">
          <button
            type="button"
            className={useAgentScope ? styles.segment : styles.segmentOn}
            aria-pressed={!useAgentScope}
            onClick={() => setUseAgentScope(false)}
          >
            Par défaut
          </button>
          <button
            type="button"
            className={useAgentScope ? styles.segmentOn : styles.segment}
            aria-pressed={useAgentScope}
            onClick={() => setUseAgentScope(true)}
          >
            {agent.name}
          </button>
        </div>
      )}
      <ErrorMessage>{error}</ErrorMessage>
      {rows.map((row) => (
        <div key={row.pattern} className={styles.row}>
          <span className={styles.pattern}>{row.pattern}</span>
          <span className={styles.origin}>{row.inherited && scope.kind === 'agent' ? 'hérité' : ''}</span>
          <div className={styles.segments} role="group" aria-label={`Politique de ${row.pattern}`}>
            {POLICY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={row.policy === option.value ? styles.segmentOn : styles.segment}
                aria-pressed={row.policy === option.value}
                onClick={() => void change(row.pattern, option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className={styles.add}>
        <label className={styles.addLabel} htmlFor="policy-new-pattern">
          Nouveau motif
        </label>
        <input
          id="policy-new-pattern"
          className={styles.input}
          placeholder="mcp__connecteur__outil*"
          value={newPattern}
          onChange={(event) => setNewPattern(event.target.value)}
        />
        <button type="button" className={styles.addButton} onClick={() => void addPattern()}>
          Ajouter
        </button>
      </div>
    </section>
  );
}
