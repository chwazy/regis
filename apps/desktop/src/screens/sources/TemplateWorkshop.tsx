import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { Entity, Job, TemplateSummary } from '@regis/shared';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage, formatDay } from '../../lib/format';
import { invokeCmd, sidecarCall } from '../../lib/ipc';
import { jobPath } from '../../lib/paths';
import { useTimezone } from '../../lib/use-timezone';
import { STATUS_LABELS } from '../job/job-view';
import styles from './sources.module.css';
import {
  isRenderable,
  parseVariables,
  SOURCE_OPTIONS,
  templateKind,
  withSource,
  type VariableSource,
} from './templates-view';

interface TemplateWorkshopProps {
  summary: TemplateSummary;
  pdfAvailable: boolean;
  onRefresh: () => Promise<void>;
}

export function TemplateWorkshop({ summary, pdfAvailable, onRefresh }: TemplateWorkshopProps) {
  const timezone = useTimezone();
  const { template, file } = summary;
  const variables = parseVariables(template.variablesJson);
  const [instructions, setInstructions] = useState(template.instructions);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [generating, setGenerating] = useState(false);
  const [entityId, setEntityId] = useState('');
  const [toPdf, setToPdf] = useState(false);
  const [startedJob, setStartedJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sidecarCall('templates.detect', { templateId: template.id })
      .then(onRefresh)
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, [template.id, onRefresh]);

  const fail = (reason: unknown) => setError(errorMessage(reason));

  const changeSource = (key: string, source: VariableSource) =>
    invokeCmd('update_template', {
      id: template.id,
      patch: { variablesJson: withSource(variables, key, source) },
    })
      .then(onRefresh)
      .catch(fail);

  const saveInstructions = () => {
    if (instructions === template.instructions) {
      return;
    }
    invokeCmd('update_template', { id: template.id, patch: { instructions } }).then(onRefresh).catch(fail);
  };

  const openGenerate = () => {
    setGenerating(true);
    setStartedJob(null);
    invokeCmd<Entity[]>('list_linkable_entities').then(setEntities).catch(fail);
  };

  const generate = (event: FormEvent) => {
    event.preventDefault();
    sidecarCall<Job>('templates.generate', {
      templateId: template.id,
      entityId,
      ...(toPdf && pdfAvailable ? { toPdf: true } : {}),
    })
      .then((job) => {
        setStartedJob(job);
        setGenerating(false);
        setError(null);
        return onRefresh();
      })
      .catch(fail);
  };

  return (
    <aside aria-label="Atelier du modèle" className={styles.workshop}>
      <div className={styles.block}>
        <span className={styles.hint}>Atelier · {templateKind(file.ext, pdfAvailable)}</span>
        <h2 className={styles.workshopTitle}>{template.name}</h2>
        <span className={styles.hint}>
          {file.relPath} · v{String(template.version)}
        </span>
      </div>

      <div className={styles.block}>
        <span className={controls.label}>Variables détectées</span>
        {variables.length === 0 && <p className={styles.empty}>Aucune variable détectée.</p>}
        {variables.map((variable) => (
          <div key={variable.key} className={styles.variableRow}>
            <span className={styles.variableKey}>{variable.key}</span>
            <select
              aria-label={`Source de ${variable.key}`}
              className={`${controls.select} ${styles.variableSource}`}
              value={variable.source}
              onChange={(event) => void changeSource(variable.key, event.target.value as VariableSource)}
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className={styles.block}>
        <label htmlFor="template-instructions" className={controls.label}>
          Consignes pour l’agent
        </label>
        <textarea
          id="template-instructions"
          rows={3}
          className={controls.textarea}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={saveInstructions}
        />
      </div>

      <div className={styles.block}>
        <span className={controls.label}>Utilisé récemment</span>
        {summary.recentUses.length === 0 && <p className={styles.empty}>Pas encore utilisé.</p>}
        {summary.recentUses.map((use) => {
          const title = use.jobTitle ?? use.fileName;
          const status = use.jobStatus
            ? (STATUS_LABELS[use.jobStatus as keyof typeof STATUS_LABELS] ?? use.jobStatus)
            : formatDay(use.usedAt, timezone);
          return use.jobId ? (
            <Link key={use.fileId} to={jobPath(use.jobId)} className={styles.useRow}>
              <span>{title}</span>
              <span className={styles.useMeta}>{status}</span>
            </Link>
          ) : (
            <div key={use.fileId} className={styles.useRow}>
              <span>{title}</span>
              <span className={styles.useMeta}>{formatDay(use.usedAt, timezone)}</span>
            </div>
          );
        })}
      </div>

      <ErrorMessage>{error}</ErrorMessage>
      {startedJob && (
        <p className={styles.hint}>
          Génération lancée : <Link to={jobPath(startedJob.id)}>{startedJob.title}</Link>
        </p>
      )}

      {generating && (
        <form className={styles.generateForm} onSubmit={generate}>
          <label className={styles.field}>
            Entité
            <select
              className={controls.select}
              value={entityId}
              onChange={(event) => setEntityId(event.target.value)}
              required
            >
              <option value="">Choisir…</option>
              {entities.map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.name}
                </option>
              ))}
            </select>
          </label>
          {pdfAvailable && file.ext === 'docx' && (
            <label className={styles.checkbox}>
              <input type="checkbox" checked={toPdf} onChange={(event) => setToPdf(event.target.checked)} />
              Aussi en PDF
            </label>
          )}
          <button type="submit" className={controls.primary} disabled={entityId === ''}>
            Lancer
          </button>
          <button type="button" className={controls.secondary} onClick={() => setGenerating(false)}>
            Annuler
          </button>
        </form>
      )}

      <div className={styles.workshopActions}>
        <button
          type="button"
          className={controls.primary}
          disabled={!isRenderable(file.ext)}
          onClick={openGenerate}
        >
          Générer un document…
        </button>
        <button
          type="button"
          className={controls.secondary}
          onClick={() => void invokeCmd('open_template', { id: template.id }).catch(fail)}
        >
          Ouvrir le modèle
        </button>
      </div>
    </aside>
  );
}
