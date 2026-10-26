import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Agent, Connector } from '@regis/shared';
import { ROUTES } from '../../app/routes';
import { isAgentSimulated, type AgentActivity, type DetectResult } from '../agents/activity';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage, formatUsd } from '../../lib/format';
import { invokeCmd } from '../../lib/ipc';
import {
  RUNTIME_OPTIONS,
  connectorIds,
  isEditorDirty,
  modeLabel,
  toggleConnector,
  type EditorSnapshot,
} from './agent-labels';
import styles from './agents.module.css';
import { InstructionsEditor, agentInstructionsSetting } from './InstructionsEditor';
import { RuntimeBadge } from './RuntimeBadge';

export interface AgentTestOutcome {
  ok: boolean;
  latencyMs: number;
  costUsd: number;
  error?: string;
}

export interface EditorSettings {
  claudeBin: string;
}

export interface EditorSubmission {
  agent: Agent;
  settings: EditorSettings;
  apiKey: string;
}

interface AgentEditorProps {
  agent: Agent;
  isNew: boolean;
  connectors: Connector[];
  settings: EditorSettings;
  detect: DetectResult | null;
  detectedClaude: string | null;
  activity: AgentActivity | null;
  onSave: (submission: EditorSubmission) => Promise<Agent>;
  onTest: (agent: Agent, settings: EditorSettings) => Promise<AgentTestOutcome>;
  onCancelNew: () => void;
}

interface Feedback {
  text: string;
  ok: boolean;
}

function describeTest(result: AgentTestOutcome, agent: Agent): string {
  if (!result.ok) {
    return `Échec : ${result.error ?? 'erreur inconnue'}`;
  }
  const cost = result.costUsd > 0 ? ` · coût ${formatUsd(result.costUsd)}` : '';
  const estimate = agent.runtime === 'claude-cli' ? cost : '';
  return `OK · ${result.latencyMs} ms${estimate}`;
}

function settingsLink(tab: string, agentId?: string): string {
  const agentParam = agentId ? `&agent=${encodeURIComponent(agentId)}` : '';
  return `${ROUTES.agentSettings}?onglet=${tab}${agentParam}`;
}

function Section({
  title,
  description,
  link,
  wide = false,
  children,
}: {
  title: string;
  description: string;
  link?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className={wide ? styles.sectionWide : styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionName}>{title}</h3>
        {link}
      </div>
      <p className={styles.sectionDescription}>{description}</p>
      {children}
    </section>
  );
}

function Switch({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className={styles.switch}>
      <input
        type="checkbox"
        role="switch"
        className="sr-only"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={styles.switchTrack} aria-hidden="true" />
      {children}
    </label>
  );
}

function UserConfigToggle({ agentId }: { agentId: string }) {
  const settingKey = `agents.loadUserConfig.${agentId}`;
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    invokeCmd<string | null>('get_setting', { key: settingKey })
      .then((value) => active && setEnabled(value === 'true'))
      .catch((reason: unknown) => active && setError(errorMessage(reason)));
    return () => {
      active = false;
    };
  }, [settingKey]);

  const change = (next: boolean) => {
    setEnabled(next);
    invokeCmd('set_setting', { key: settingKey, value: next ? 'true' : '' })
      .then(() => setError(null))
      .catch((reason: unknown) => {
        setEnabled(!next);
        setError(errorMessage(reason));
      });
  };

  return (
    <>
      <div className={styles.toggleRow}>
        <span className={styles.toggleText}>
          <span className={styles.toggleTitle}>Charger ma config ~/.claude</span>
          <span className={styles.hint}>
            Tes skills, agents et plugins. Ton settings.json s’applique aussi : ses hooks tournent et ses
            règles allow passent avant la validation de Régis.
          </span>
        </span>
        <Switch checked={enabled} onChange={change}>
          <span className="sr-only">Charger ma config ~/.claude</span>
        </Switch>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
    </>
  );
}

function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <span className={ok ? styles.statusOk : styles.statusWarn}>{children}</span>;
}

export function AgentEditor({
  agent,
  isNew,
  connectors,
  settings,
  detect,
  detectedClaude,
  activity,
  onSave,
  onTest,
  onCancelNew,
}: AgentEditorProps) {
  const [draft, setDraft] = useState<Agent>(agent);
  const [claudeBin, setClaudeBin] = useState(settings.claudeBin);
  const [apiKey, setApiKey] = useState('');
  const [renaming, setRenaming] = useState(isNew);
  const [busy, setBusy] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<Feedback | null>(null);
  const [testFeedback, setTestFeedback] = useState<Feedback | null>(null);
  const [initial, setInitial] = useState<EditorSnapshot>({
    agent,
    claudeBin: settings.claudeBin,
    apiKey: '',
  });

  const update = (patch: Partial<Agent>) => setDraft((current) => ({ ...current, ...patch }));
  const dirty = isNew || isEditorDirty(initial, { agent: draft, claudeBin, apiKey });
  const selectedConnectors = connectorIds(draft);
  const runtimeLabel =
    RUNTIME_OPTIONS.find((option) => option.value === draft.runtime)?.label ?? draft.runtime;

  const save = async () => {
    setBusy(true);
    setSaveFeedback(null);
    try {
      const saved = await onSave({ agent: draft, settings: { claudeBin }, apiKey });
      setDraft(saved);
      setInitial({ agent: saved, claudeBin, apiKey: '' });
      setApiKey('');
      setSaveFeedback({ text: 'Enregistré', ok: true });
    } catch (reason) {
      setSaveFeedback({ text: errorMessage(reason), ok: false });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setTestFeedback(null);
    try {
      const result = await onTest(draft, { claudeBin });
      setTestFeedback({ text: describeTest(result, draft), ok: result.ok });
    } catch (reason) {
      setTestFeedback({ text: errorMessage(reason), ok: false });
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (isNew) {
      onCancelNew();
      return;
    }
    setDraft(initial.agent);
    setClaudeBin(initial.claudeBin);
    setApiKey('');
    setSaveFeedback(null);
  };

  return (
    <section aria-label="Édition de l’agent" className={styles.detailCard}>
      <div className={styles.detailHead}>
        <RuntimeBadge runtime={draft.runtime} large />
        <div className={styles.detailHeadText}>
          {renaming ? (
            <input
              aria-label="Nom de l’agent"
              className={styles.nameInput}
              value={draft.name}
              autoFocus
              onChange={(event) => update({ name: event.target.value })}
              onBlur={() => setRenaming(draft.name.trim() === '')}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && draft.name.trim() !== '') {
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <h2 className={styles.detailTitle}>
              {draft.name}
              <button type="button" className={styles.renameButton} onClick={() => setRenaming(true)}>
                ✎ renommer
              </button>
            </h2>
          )}
          <span className={styles.detailMeta}>
            {runtimeLabel} · Pilotage {modeLabel(draft.mode)}
          </span>
        </div>
        <div className={styles.detailActions}>
          {dirty && !isNew && (
            <span className={styles.dirty}>
              <span className={styles.dot} aria-hidden="true" />
              Modifications non enregistrées
            </span>
          )}
          {saveFeedback && !dirty && (
            <span role="status" className={saveFeedback.ok ? styles.statusOk : styles.statusError}>
              {saveFeedback.text}
            </span>
          )}
          <Switch checked={draft.enabled} onChange={(enabled) => update({ enabled })}>
            Activé
          </Switch>
          <button type="button" className={styles.secondaryButton} disabled={busy || !dirty} onClick={cancel}>
            Annuler
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={busy || !dirty || draft.name.trim() === ''}
            onClick={() => void save()}
          >
            Enregistrer
          </button>
        </div>
      </div>
      {saveFeedback && !saveFeedback.ok && dirty && (
        <div className={styles.detailError}>
          <ErrorMessage>{saveFeedback.text}</ErrorMessage>
        </div>
      )}

      <div className={styles.sections}>
        <Section title="Connexion" description="Comment Régis lance cet agent.">
          {draft.runtime === 'claude-cli' && (
            <div className={styles.field}>
              <label htmlFor="ag-bin" className={styles.fieldLabel}>
                Exécutable
              </label>
              <input
                id="ag-bin"
                className={styles.monoInput}
                value={claudeBin}
                placeholder={detectedClaude ?? 'claude'}
                onChange={(event) => setClaudeBin(event.target.value)}
              />
              {detect !== null &&
                (detectedClaude ? (
                  <Status ok>
                    {isAgentSimulated(draft, detect)
                      ? '✓ Simulé (démo) : la CLI de démonstration répond à la place de Claude Code.'
                      : `✓ Détecté : ${detectedClaude}`}
                  </Status>
                ) : (
                  <Status ok={false}>
                    ⚠ Non détecté dans le PATH : indique le chemin de la CLI ci-dessus.
                  </Status>
                ))}
            </div>
          )}

          <div className={styles.field}>
            <label htmlFor="ag-model" className={styles.fieldLabel}>
              Modèle
            </label>
            <input
              id="ag-model"
              className={styles.monoInput}
              value={draft.model ?? ''}
              placeholder={draft.runtime === 'claude-cli' ? 'Défaut de la CLI (ex. sonnet)' : undefined}
              onChange={(event) => update({ model: event.target.value || null })}
            />
            {draft.runtime === 'ollama' && detect !== null && (
              <Status ok={detect.ollama !== undefined}>
                {detect.ollama !== undefined ? '✓ Ollama joignable' : '⚠ Ollama injoignable'}
              </Status>
            )}
          </div>

          {draft.runtime === 'anthropic-api' && (
            <div className={styles.field}>
              <label htmlFor="ag-key" className={styles.fieldLabel}>
                Clé API
              </label>
              <input
                id="ag-key"
                type="password"
                autoComplete="off"
                className={styles.monoInput}
                value={apiKey}
                placeholder={draft.secretRef ? 'Saisir une nouvelle clé pour la remplacer' : 'sk-…'}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <Status ok={draft.secretRef !== null}>
                {draft.secretRef !== null
                  ? '✓ Clé enregistrée dans le coffre de l’OS'
                  : '⚠ Aucune clé enregistrée'}
              </Status>
            </div>
          )}

          <div className={styles.testRow}>
            <button
              type="button"
              className={styles.smallButton}
              disabled={busy || isNew}
              title={isNew ? 'Enregistre l’agent pour pouvoir le tester' : undefined}
              onClick={() => void test()}
            >
              ⟳ Tester la connexion
            </button>
            {isNew && <span className={styles.hint}>Disponible après l’enregistrement.</span>}
            {testFeedback && (
              <span role="status" className={testFeedback.ok ? styles.statusOk : styles.statusError}>
                {testFeedback.text}
              </span>
            )}
          </div>
        </Section>

        <Section
          title="Budget"
          description={
            draft.runtime === 'claude-cli'
              ? 'Plafond passé à la CLI (--max-budget-usd).'
              : 'Plafond de dépense quotidien, pris en compte par le routage.'
          }
        >
          <div className={styles.field}>
            <label htmlFor="ag-budget" className={styles.fieldLabel}>
              Budget par jour
            </label>
            <div className={styles.suffixInput}>
              <input
                id="ag-budget"
                type="number"
                min="0"
                step="0.01"
                className={styles.suffixField}
                value={draft.budgetDailyUsd ?? ''}
                placeholder="illimité"
                onChange={(event) =>
                  update({ budgetDailyUsd: event.target.value === '' ? null : Number(event.target.value) })
                }
              />
              <span className={styles.suffix}>USD / jour</span>
            </div>
            {draft.runtime === 'claude-cli' && (
              <span className={styles.hint}>
                Le coût affiché par Claude Code est une estimation locale, pas une facturation.
              </span>
            )}
          </div>
          {activity && (
            <span className={styles.hint}>
              Aujourd’hui :{' '}
              <span className={styles.mono}>
                {draft.isLocalOnly ? 'local' : formatUsd(activity.costTodayUsd)}
              </span>{' '}
              · {activity.jobsToday} tâche{activity.jobsToday > 1 ? 's' : ''}
            </span>
          )}
        </Section>

        <Section
          wide
          title="Quand l’utiliser"
          description="Indice lu par l’orchestrateur quand aucune règle de routage ne s’applique."
          link={
            <Link to={settingsLink('routage')} className={styles.sectionLink}>
              Règles de routage →
            </Link>
          }
        >
          <textarea
            aria-label="Utiliser cet agent quand…"
            rows={3}
            className={styles.textarea}
            value={draft.useWhen}
            onChange={(event) => update({ useWhen: event.target.value })}
          />
        </Section>

        {!isNew && (
          <Section
            wide
            title="Instructions"
            description="Ajoutées au prompt système de chaque tâche de cet agent, après les instructions globales."
          >
            <InstructionsEditor
              settingKey={agentInstructionsSetting(draft.id)}
              label={`Instructions de ${draft.name}`}
            />
          </Section>
        )}

        <Section title="Capacités" description="Ce que l’agent a le droit de faire de lui-même.">
          <div className={styles.toggleRow}>
            <span className={styles.toggleText}>
              <span className={styles.toggleTitle}>Lancer des sous-tâches</span>
              <span className={styles.hint}>Peut découper une tâche et déléguer.</span>
            </span>
            <Switch checked={draft.canSpawn} onChange={(canSpawn) => update({ canSpawn })}>
              <span className="sr-only">Lancer des sous-tâches</span>
            </Switch>
          </div>
          <div className={styles.toggleRow}>
            <span className={styles.toggleText}>
              <span className={styles.toggleTitle}>Un git worktree par tâche</span>
              <span className={styles.hint}>Travaille sur une branche isolée, jamais dans ton checkout.</span>
            </span>
            <Switch checked={draft.worktreePerJob} onChange={(worktreePerJob) => update({ worktreePerJob })}>
              <span className="sr-only">Un git worktree par tâche</span>
            </Switch>
          </div>
          {!isNew && draft.runtime === 'claude-cli' && <UserConfigToggle agentId={draft.id} />}
        </Section>

        <Section
          title="Outils MCP"
          description="Connecteurs exposés à l’agent. Les écritures restent soumises à la politique."
          link={
            isNew ? undefined : (
              <Link to={settingsLink('politique', draft.id)} className={styles.sectionLink}>
                Politique de cet agent →
              </Link>
            )
          }
        >
          <div className={styles.chips}>
            {connectors.length === 0 && <span className={styles.hint}>Aucun connecteur configuré.</span>}
            {connectors.map((connector) => {
              const on = selectedConnectors.includes(connector.id);
              return (
                <button
                  key={connector.id}
                  type="button"
                  aria-pressed={on}
                  className={on ? styles.chipOn : styles.chip}
                  onClick={() => setDraft(toggleConnector(draft, connector.id))}
                >
                  {on && '✓ '}
                  {connector.name}
                </button>
              );
            })}
          </div>
        </Section>
      </div>

      <p className={styles.detailFoot}>Runtime et mode de pilotage sont fixés à la création.</p>
    </section>
  );
}
