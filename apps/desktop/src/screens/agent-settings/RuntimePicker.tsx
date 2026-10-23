import type { AgentRuntime } from '@regis/shared';
import { StatusPill } from '../../components/ui/StatusPill';
import { isAgentAvailable, isAgentSimulated, type DetectResult } from '../agents/activity';
import { RUNTIME_OPTIONS, RUNTIME_PITCH, newAgentDraft, withRuntime } from './agent-labels';
import styles from './agents.module.css';
import { RuntimeBadge } from './RuntimeBadge';

interface RuntimePickerProps {
  value: AgentRuntime;
  detect: DetectResult | null;
  onChange: (runtime: AgentRuntime) => void;
  onCancel: () => void;
  onContinue: () => void;
}

function detectionLabel(runtime: AgentRuntime, detect: DetectResult | null): string | null {
  if (runtime === 'claude-cli' && detect?.claude) {
    return isAgentSimulated(withRuntime(newAgentDraft(), 'claude-cli'), detect)
      ? 'Simulé (démo)'
      : `détecté v${detect.claude.version}`;
  }
  if (runtime === 'ollama') {
    return isAgentAvailable(withRuntime(newAgentDraft(), 'ollama'), detect) ? 'joignable' : null;
  }
  return null;
}

export function RuntimePicker({ value, detect, onChange, onCancel, onContinue }: RuntimePickerProps) {
  return (
    <section aria-label="Nouvel agent" className={styles.detailCard}>
      <div className={styles.detailHead}>
        <div className={styles.detailHeadText}>
          <h2 className={styles.detailTitle}>Nouvel agent</h2>
          <span className={styles.detailMeta}>
            Choisis d’abord le type d’agent : il détermine la connexion et le mode de pilotage.
          </span>
        </div>
        <div className={styles.detailActions}>
          <button type="button" className={styles.secondaryButton} onClick={onCancel}>
            Annuler
          </button>
          <button type="button" className={styles.primaryButton} onClick={onContinue}>
            Continuer
          </button>
        </div>
      </div>
      <div className={styles.runtimeGrid} role="radiogroup" aria-label="Type d’agent">
        {RUNTIME_OPTIONS.map((option) => {
          const detected = option.available ? detectionLabel(option.value, detect) : null;
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={
                !option.available
                  ? styles.runtimeOptionOff
                  : checked
                    ? styles.runtimeOptionOn
                    : styles.runtimeOption
              }
            >
              <input
                type="radio"
                name="runtime"
                className="sr-only"
                value={option.value}
                checked={checked}
                disabled={!option.available}
                onChange={() => onChange(option.value)}
              />
              <span className={styles.runtimeOptionHead}>
                <RuntimeBadge runtime={option.value} />
                {option.label}
              </span>
              <span className={styles.hint}>{RUNTIME_PITCH[option.value]}</span>
              {detected && (
                <StatusPill tone="ok" title={detected}>
                  ✓ {detected}
                </StatusPill>
              )}
            </label>
          );
        })}
      </div>
    </section>
  );
}
