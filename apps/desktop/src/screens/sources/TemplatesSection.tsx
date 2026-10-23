import { useState, type FormEvent } from 'react';
import type { TemplateSummary } from '@regis/shared';
import { CollapseButton } from '../../components/ui/CollapseButton';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { useCollapsed } from '../../lib/use-collapsed';
import { useStoredChoice } from '../../lib/use-stored-choice';
import styles from './sources.module.css';
import { countLabel, parseVariables } from './templates-view';

const TEMPLATE_VIEWS = ['tiles', 'list'] as const;
type TemplateView = (typeof TEMPLATE_VIEWS)[number];
const VIEW_LABELS: Record<TemplateView, string> = { tiles: 'Tuiles', list: 'Liste' };
const VIEW_KEY = 'sources.templates.view';
const COLLAPSED_KEY = 'sources.templates.collapsed';
const LIST_ID = 'sources-templates-list';

interface TemplatesSectionProps {
  templates: TemplateSummary[];
  selectedId: string | null;
  error: string | null;
  onSelect: (templateId: string) => void;
  onImport: (path: string) => Promise<void>;
}

export function TemplatesSection({
  templates,
  selectedId,
  error,
  onSelect,
  onImport,
}: TemplatesSectionProps) {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useStoredChoice<TemplateView>(VIEW_KEY, TEMPLATE_VIEWS, 'tiles');
  const [collapsed, toggleCollapsed] = useCollapsed(COLLAPSED_KEY);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    onImport(path.trim())
      .then(() => {
        setPath('');
        setAdding(false);
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <section aria-label="Modèles" className={styles.section}>
      <div className={styles.collapsibleHead}>
        <h2 className={styles.sectionTitle}>Modèles</h2>
        <span className={styles.hint}>documents à variables que les agents remplissent</span>
        <div className={styles.headActions}>
          <div className={styles.viewSwitch} role="group" aria-label="Affichage des modèles">
            {TEMPLATE_VIEWS.map((option) => (
              <button
                key={option}
                type="button"
                className={view === option ? controls.chipOn : controls.chip}
                aria-pressed={view === option}
                onClick={() => setView(option)}
              >
                {VIEW_LABELS[option]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={controls.primarySm}
            onClick={() => setAdding((current) => !current)}
          >
            + Nouveau modèle
          </button>
          <CollapseButton
            collapsed={collapsed}
            controls={LIST_ID}
            label="les modèles"
            onToggle={toggleCollapsed}
          />
        </div>
      </div>
      {!collapsed && adding && (
        <form className={styles.generateForm} onSubmit={submit}>
          <label className={styles.fieldWide}>
            Fichier du modèle (DOCX, Markdown, XLSX)
            <input
              className={controls.input}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="Chemin complet du fichier"
              required
            />
          </label>
          <button type="submit" className={controls.primary} disabled={busy || path.trim() === ''}>
            Importer
          </button>
        </form>
      )}
      <ErrorMessage>{error}</ErrorMessage>
      {!collapsed && templates.length === 0 && <p className={styles.empty}>Aucun modèle.</p>}
      <div
        id={LIST_ID}
        hidden={collapsed}
        className={view === 'tiles' ? styles.templateGrid : styles.templateList}
      >
        {templates.map((summary) => {
          const selected = summary.template.id === selectedId;
          const ext = <span className={styles.ext}>{summary.file.ext.toUpperCase() || '—'}</span>;
          const uses = (
            <span className={styles.cardUses}>{countLabel(summary.usageCount, 'usage', 'usages')}</span>
          );
          const variables = (
            <span className={styles.hint}>
              {countLabel(parseVariables(summary.template.variablesJson).length, 'variable', 'variables')}
            </span>
          );
          return (
            <button
              key={summary.template.id}
              type="button"
              aria-pressed={selected}
              className={
                view === 'tiles'
                  ? selected
                    ? styles.templateCardSelected
                    : styles.templateCard
                  : selected
                    ? styles.templateRowSelected
                    : styles.templateRow
              }
              onClick={() => onSelect(summary.template.id)}
            >
              {view === 'tiles' ? (
                <>
                  <span className={styles.cardHead}>
                    {ext}
                    {uses}
                  </span>
                  <span className={styles.cardName}>{summary.template.name}</span>
                  {variables}
                </>
              ) : (
                <>
                  {ext}
                  <span className={styles.rowName}>{summary.template.name}</span>
                  {variables}
                  {uses}
                </>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
