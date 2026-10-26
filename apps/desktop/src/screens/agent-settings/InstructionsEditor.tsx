import { useEffect, useState } from 'react';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/format';
import { invokeCmd } from '../../lib/ipc';
import styles from './agents.module.css';

export const GLOBAL_INSTRUCTIONS_SETTING = 'agents.instructions.global';
export const ORCHESTRATOR_INSTRUCTIONS_SETTING = 'agents.orchestratorInstructions';

export function agentInstructionsSetting(agentId: string): string {
  return `agents.instructions.${agentId}`;
}

interface InstructionsEditorProps {
  settingKey: string;
  label: string;
}

export function InstructionsEditor({ settingKey, label }: InstructionsEditorProps) {
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    invokeCmd<string | null>('get_setting', { key: settingKey })
      .then((value) => {
        if (active) {
          setSaved(value ?? '');
          setDraft(value ?? '');
        }
      })
      .catch((reason: unknown) => active && setError(errorMessage(reason)));
    return () => {
      active = false;
    };
  }, [settingKey]);

  const save = async () => {
    setBusy(true);
    try {
      await invokeCmd('set_setting', { key: settingKey, value: draft.trim() });
      setSaved(draft.trim());
      setDraft(draft.trim());
      setError(null);
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const dirty = draft.trim() !== saved;

  return (
    <>
      <textarea
        aria-label={label}
        rows={5}
        className={styles.textarea}
        placeholder="Texte libre, ou chemin absolu d’un fichier (ex. C:\agents\orchestrator\CLAUDE.md)"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className={styles.testRow}>
        <button
          type="button"
          className={styles.smallButton}
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          Enregistrer les instructions
        </button>
        <span className={styles.hint}>Un chemin seul sur une ligne est relu à chaque tâche.</span>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
    </>
  );
}
