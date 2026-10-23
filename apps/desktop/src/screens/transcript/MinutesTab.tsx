import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Agent, Item, RecordingStatus, TemplateSummary } from '@regis/shared';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/format';
import { ROUTES } from '../../app/routes';
import { invokeCmd } from '../../lib/ipc';
import { canGenerateMinutes, generateLabel, minutesAgentId, minutesBadge } from './minutes-view';
import styles from './transcript.module.css';

interface MinutesTabProps {
  transcriptItemId: string;
  status: RecordingStatus;
  onGenerated: () => void;
}

export default function MinutesTab({ transcriptItemId, status, onGenerated }: MinutesTabProps) {
  const [minutes, setMinutes] = useState<Item | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);

  const show = useCallback((note: Item | null) => {
    setMinutes(note);
    setExported(false);
    const agentId = note === null ? null : minutesAgentId(note);
    if (agentId === null) {
      setAgentName(null);
      return;
    }
    invokeCmd<Agent[]>('list_agents')
      .then((agents) => setAgentName(agents.find((agent) => agent.id === agentId)?.name ?? null))
      .catch(() => setAgentName(null));
  }, []);

  useEffect(() => {
    invokeCmd<Item | null>('minutes_get', { transcriptItemId })
      .then(show)
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, [transcriptItemId, show]);

  const generate = () => {
    setBusy(true);
    setError(null);
    invokeCmd<Item>('minutes_generate', { transcriptItemId })
      .then((note) => {
        show(note);
        onGenerated();
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false));
  };

  const onGenerateClick = () => {
    if (minutes !== null) {
      setConfirming(true);
    } else {
      generate();
    }
  };

  const openExport = () => {
    setExported(false);
    invokeCmd<TemplateSummary[]>('list_templates')
      .then((list) => {
        setTemplates(list);
        setTemplateId((current) => (current !== '' ? current : (list[0]?.template.id ?? '')));
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  };

  const runExport = () => {
    if (minutes === null || templateId === '') {
      return;
    }
    setExporting(true);
    setError(null);
    invokeCmd<{ fileIds: string[] }>('minutes_export', { minutesItemId: minutes.id, templateId })
      .then(() => {
        setExported(true);
        setTemplates(null);
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setExporting(false));
  };

  return (
    <div className={styles.minutes}>
      <div className={styles.minutesActions}>
        <button
          type="button"
          className={controls.secondary}
          disabled={!canGenerateMinutes(status, busy)}
          onClick={onGenerateClick}
        >
          {busy ? 'Génération du PV…' : generateLabel(minutes !== null)}
        </button>
        {minutes !== null && templates === null && (
          <button type="button" className={controls.secondary} onClick={openExport}>
            Exporter…
          </button>
        )}
        {templates !== null && (
          <span className={styles.confirm}>
            {templates.length === 0 ? (
              <span className={styles.muted}>Aucun modèle disponible.</span>
            ) : (
              <>
                <label className={styles.muted} htmlFor="minutes-template">
                  Modèle
                </label>
                <select
                  id="minutes-template"
                  className={controls.select}
                  value={templateId}
                  onChange={(event) => setTemplateId(event.target.value)}
                >
                  {templates.map((summary) => (
                    <option key={summary.template.id} value={summary.template.id}>
                      {summary.template.name}
                    </option>
                  ))}
                </select>
                <button type="button" className={controls.secondary} disabled={exporting} onClick={runExport}>
                  {exporting ? 'Export…' : 'Exporter'}
                </button>
              </>
            )}
            <button type="button" className={controls.secondary} onClick={() => setTemplates(null)}>
              Fermer
            </button>
          </span>
        )}
      </div>
      {status !== 'done' && (
        <p className={styles.muted}>Le PV se génère une fois la transcription terminée.</p>
      )}
      <ErrorMessage>{error}</ErrorMessage>
      {exported && (
        <p className={styles.muted}>
          Document généré, disponible dans <Link to={ROUTES.sources}>Modèles &amp; sources</Link>.
        </p>
      )}
      {minutes === null ? (
        <p className={styles.muted}>Aucun PV pour cette réunion.</p>
      ) : (
        <>
          <p className={styles.badge}>{minutesBadge(agentName)}</p>
          <div className={styles.minutesBody} aria-label="PV">
            {minutes.bodyText ?? ''}
          </div>
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title="Remplacer le PV ?"
          confirmLabel="Remplacer le PV"
          onConfirm={generate}
          onClose={() => setConfirming(false)}
        >
          Le PV actuel sera remplacé par une nouvelle version générée à partir de la transcription.
        </ConfirmDialog>
      )}
    </div>
  );
}
