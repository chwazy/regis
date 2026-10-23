import { useCallback, useEffect, useState } from 'react';
import type { Agent, Entity, RoutingRule } from '@regis/shared';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/format';
import { invokeCmd, sidecarCall } from '../../lib/ipc';
import {
  TASK_TYPE_OPTIONS,
  WEEKDAY_OPTIONS,
  cleanConditions,
  conditionsOf,
  describeConditions,
  moveRule,
  newRule,
  omitCondition,
  withContiguousOrder,
  type EntityNames,
  type RoutingConditions,
  type TaskType,
} from './routing-rows';
import styles from './routing.module.css';

interface RoutingSectionProps {
  agents: Agent[];
}

interface PreviewDecision {
  agentId: string;
  ruleId: string | null;
  reason: string;
  viaFallback: boolean;
}

const POSSIBLE_CONDITIONS = [
  'client',
  'projet',
  'tag d’entité',
  'type de tâche',
  'source',
  'budget restant',
  'horaire',
];

interface RuleEditorProps {
  rule: RoutingRule;
  agents: Agent[];
  clients: Entity[];
  projects: Entity[];
  onApply: (rule: RoutingRule) => void;
  onCancel: () => void;
}

function RuleEditor({ rule, agents, clients, projects, onApply, onCancel }: RuleEditorProps) {
  const [conditions, setConditions] = useState<RoutingConditions>(conditionsOf(rule));
  const [agentId, setAgentId] = useState(rule.agentId);
  const [reason, setReason] = useState(rule.reason);
  const idPrefix = `rule-${rule.id === '' ? 'new' : rule.id}`;
  const window = conditions.timeWindow;
  const patch = (change: Partial<RoutingConditions>) => setConditions({ ...conditions, ...change });
  const patchWindow = (change: Partial<NonNullable<RoutingConditions['timeWindow']>>) =>
    patch({ timeWindow: { from: window?.from ?? '', to: window?.to ?? '', ...window, ...change } });
  const toggleDay = (day: number) => {
    const days = window?.days ?? [];
    patchWindow({ days: days.includes(day) ? days.filter((entry) => entry !== day) : [...days, day] });
  };

  return (
    <form
      className={styles.editor}
      aria-label="Éditeur de règle"
      onSubmit={(event) => {
        event.preventDefault();
        onApply({ ...rule, agentId, reason: reason.trim(), conditionsJson: cleanConditions(conditions) });
      }}
    >
      <div className={styles.grid}>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-client`} className={styles.label}>
            Client
          </label>
          <select
            id={`${idPrefix}-client`}
            className={styles.input}
            value={conditions.client ?? ''}
            onChange={(event) => patch({ client: event.target.value })}
          >
            <option value="">Tous</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-project`} className={styles.label}>
            Projet
          </label>
          <select
            id={`${idPrefix}-project`}
            className={styles.input}
            value={conditions.project ?? ''}
            onChange={(event) => patch({ project: event.target.value })}
          >
            <option value="">Tous</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-tag`} className={styles.label}>
            Tag d’entité
          </label>
          <input
            id={`${idPrefix}-tag`}
            className={styles.input}
            value={conditions.entityTag ?? ''}
            onChange={(event) => patch({ entityTag: event.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-type`} className={styles.label}>
            Type de tâche
          </label>
          <select
            id={`${idPrefix}-type`}
            className={styles.input}
            value={conditions.taskType ?? ''}
            onChange={(event) => {
              const others = omitCondition(conditions, 'taskType');
              setConditions(
                event.target.value === '' ? others : { ...others, taskType: event.target.value as TaskType },
              );
            }}
          >
            <option value="">Tous</option>
            {TASK_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-source`} className={styles.label}>
            Source
          </label>
          <input
            id={`${idPrefix}-source`}
            className={styles.input}
            value={conditions.source ?? ''}
            onChange={(event) => patch({ source: event.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-budget`} className={styles.label}>
            Budget restant sous (%)
          </label>
          <input
            id={`${idPrefix}-budget`}
            className={styles.input}
            type="number"
            min={0}
            max={100}
            value={conditions.budgetRemainingPctBelow ?? ''}
            onChange={(event) => {
              const others = omitCondition(conditions, 'budgetRemainingPctBelow');
              setConditions(
                event.target.value === ''
                  ? others
                  : { ...others, budgetRemainingPctBelow: Number(event.target.value) },
              );
            }}
          />
        </div>
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>Horaire (fuseau de l’application)</legend>
        <div className={styles.windowRow}>
          <label htmlFor={`${idPrefix}-from`} className={styles.label}>
            De
          </label>
          <input
            id={`${idPrefix}-from`}
            className={styles.timeInput}
            type="time"
            value={window?.from ?? ''}
            onChange={(event) => patchWindow({ from: event.target.value })}
          />
          <label htmlFor={`${idPrefix}-to`} className={styles.label}>
            à
          </label>
          <input
            id={`${idPrefix}-to`}
            className={styles.timeInput}
            type="time"
            value={window?.to ?? ''}
            onChange={(event) => patchWindow({ to: event.target.value })}
          />
          {WEEKDAY_OPTIONS.map((day) => (
            <label key={day.value} className={styles.day}>
              <input
                type="checkbox"
                checked={window?.days?.includes(day.value) ?? false}
                onChange={() => toggleDay(day.value)}
              />
              {day.label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={conditions.requireLocal === true}
          onChange={(event) => patch({ requireLocal: event.target.checked })}
        />
        Local uniquement (Ollama, rien ne part vers un service externe)
      </label>

      <div className={styles.grid}>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-agent`} className={styles.label}>
            Agent cible
          </label>
          <select
            id={`${idPrefix}-agent`}
            className={styles.input}
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${idPrefix}-reason`} className={styles.label}>
            Explication
          </label>
          <input
            id={`${idPrefix}-reason`}
            className={styles.input}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>

      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={agentId === ''}>
          Appliquer
        </button>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

export function RoutingSection({ agents }: RoutingSectionProps) {
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [editing, setEditing] = useState<RoutingRule | null>(null);
  const [deleting, setDeleting] = useState<RoutingRule | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testTask, setTestTask] = useState('');
  const [testType, setTestType] = useState<TaskType | ''>('');
  const [testClient, setTestClient] = useState('');
  const [testProject, setTestProject] = useState('');
  const [decision, setDecision] = useState<PreviewDecision | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    invokeCmd<RoutingRule[]>('list_rules')
      .then((loaded) => active && setRules(loaded))
      .catch((reason: unknown) => active && setError(errorMessage(reason)));
    invokeCmd<Entity[]>('list_linkable_entities')
      .then((loaded) => active && setEntities(loaded))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const clients = entities.filter((entity) => entity.kind === 'client');
  const projects = entities.filter((entity) => entity.kind === 'project');
  const names: EntityNames = Object.fromEntries(entities.map((entity) => [entity.id, entity.name]));
  const agentName = (agentId: string): string =>
    agents.find((agent) => agent.id === agentId)?.name ?? agentId;

  const persist = useCallback(async (next: RoutingRule[]) => {
    try {
      const saved = await invokeCmd<RoutingRule[]>('save_rules', { rules: withContiguousOrder(next) });
      setRules(saved);
      setError(null);
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    }
  }, []);

  const reorder = (from: number, to: number) => {
    setDragIndex(null);
    setOverIndex(null);
    if (from !== to) {
      void persist(moveRule(rules, from, to));
    }
  };

  const apply = (edited: RoutingRule) => {
    const exists = rules.some((rule) => rule.id === edited.id && edited.id !== '');
    setEditing(null);
    void persist(exists ? rules.map((rule) => (rule.id === edited.id ? edited : rule)) : [...rules, edited]);
  };

  const runPreview = async () => {
    setDecision(null);
    setTestError(null);
    try {
      setDecision(
        await sidecarCall<PreviewDecision>('routing.preview', {
          task: testTask,
          ...(testType === '' ? {} : { taskType: testType }),
          ...(testClient === '' ? {} : { clientId: testClient }),
          ...(testProject === '' ? {} : { projectId: testProject }),
        }),
      );
    } catch (reason: unknown) {
      setTestError(errorMessage(reason));
    }
  };

  return (
    <section aria-label="Règles de routage" className={styles.card}>
      <div className={styles.head}>
        <h2 className={styles.title}>Règles de routage</h2>
        <span className={styles.caption}>
          évaluées dans l’ordre · la première qui correspond gagne · l’orchestrateur explique son choix
        </span>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => setEditing(newRule(agents))}
          disabled={agents.length === 0}
        >
          + Règle
        </button>
      </div>
      <div className={styles.chips}>
        <span className={styles.chipsLabel}>Conditions possibles :</span>
        {POSSIBLE_CONDITIONS.map((condition) => (
          <span key={condition} className={styles.chip}>
            {condition}
          </span>
        ))}
      </div>

      <ErrorMessage>{error}</ErrorMessage>

      <ol className={styles.list}>
        {rules.map((rule, index) => (
          <li
            key={rule.id}
            className={overIndex === index && dragIndex !== index ? styles.rowOver : styles.row}
            draggable
            onDragStart={() => setDragIndex(index)}
            onDragOver={(event) => {
              event.preventDefault();
              setOverIndex(index);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragIndex !== null) {
                reorder(dragIndex, index);
              }
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
          >
            <span className={styles.rank}>{index + 1}</span>
            <div className={styles.body}>
              <span className={rule.enabled ? styles.when : styles.whenOff}>
                <span className={styles.muted}>Si </span>
                {describeConditions(conditionsOf(rule), names)}
              </span>
              {rule.reason !== '' && <span className={styles.why}>{rule.reason}</span>}
            </div>
            <span className={styles.arrow} aria-hidden="true">
              →
            </span>
            <span className={styles.target}>{agentName(rule.agentId)}</span>
            {conditionsOf(rule).requireLocal === true && (
              <span className={styles.local}>Local uniquement</span>
            )}
            <div className={styles.rowActions}>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={`Monter la règle ${String(index + 1)}`}
                disabled={index === 0}
                onClick={() => reorder(index, index - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={`Descendre la règle ${String(index + 1)}`}
                disabled={index === rules.length - 1}
                onClick={() => reorder(index, index + 1)}
              >
                ↓
              </button>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(event) =>
                    void persist(
                      rules.map((entry) =>
                        entry.id === rule.id ? { ...entry, enabled: event.target.checked } : entry,
                      ),
                    )
                  }
                />
                Active
              </label>
              <button type="button" className={styles.linkButton} onClick={() => setEditing(rule)}>
                Modifier
              </button>
              <button type="button" className={styles.dangerLink} onClick={() => setDeleting(rule)}>
                Supprimer
              </button>
            </div>
          </li>
        ))}
      </ol>
      {rules.length === 0 && !error && (
        <p className={styles.empty}>Aucune règle : l’orchestrateur choisit d’après les indices des agents.</p>
      )}

      {deleting && (
        <ConfirmDialog
          title="Supprimer la règle ?"
          confirmLabel="Supprimer"
          onConfirm={() => persist(rules.filter((entry) => entry.id !== deleting.id))}
          onClose={() => setDeleting(null)}
        >
          {deleting.reason === ''
            ? 'Cette règle de routage sera supprimée.'
            : `La règle « ${deleting.reason} » sera supprimée.`}
        </ConfirmDialog>
      )}

      {editing && (
        <RuleEditor
          key={editing.id === '' ? 'new' : editing.id}
          rule={editing}
          agents={agents}
          clients={clients}
          projects={projects}
          onApply={apply}
          onCancel={() => setEditing(null)}
        />
      )}

      <form
        className={styles.test}
        aria-label="Tester une tâche"
        onSubmit={(event) => {
          event.preventDefault();
          void runPreview();
        }}
      >
        <h3 className={styles.subtitle}>Tester une tâche</h3>
        <label htmlFor="routing-test-task" className={styles.label}>
          Description de la tâche
        </label>
        <textarea
          id="routing-test-task"
          className={styles.textarea}
          rows={2}
          value={testTask}
          onChange={(event) => setTestTask(event.target.value)}
        />
        <div className={styles.grid}>
          <div className={styles.field}>
            <label htmlFor="routing-test-type" className={styles.label}>
              Type de tâche
            </label>
            <select
              id="routing-test-type"
              className={styles.input}
              value={testType}
              onChange={(event) => setTestType(event.target.value as TaskType | '')}
            >
              <option value="">Autre</option>
              {TASK_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="routing-test-client" className={styles.label}>
              Client
            </label>
            <select
              id="routing-test-client"
              className={styles.input}
              value={testClient}
              onChange={(event) => setTestClient(event.target.value)}
            >
              <option value="">Aucun</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="routing-test-project" className={styles.label}>
              Projet
            </label>
            <select
              id="routing-test-project"
              className={styles.input}
              value={testProject}
              onChange={(event) => setTestProject(event.target.value)}
            >
              <option value="">Aucun</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={testTask.trim() === ''}>
            Tester
          </button>
        </div>
        <ErrorMessage>{testError}</ErrorMessage>
        {decision && (
          <p className={styles.result} aria-live="polite">
            <span className={styles.target}>{agentName(decision.agentId)}</span>
            <span className={styles.why}>
              {decision.reason}
              {decision.viaFallback ? ' (choix de l’orchestrateur)' : ''}
            </span>
          </p>
        )}
      </form>
    </section>
  );
}
