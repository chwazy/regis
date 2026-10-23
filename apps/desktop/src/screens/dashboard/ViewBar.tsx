import { useState, type FormEvent } from 'react';
import type { Dashboard } from '@regis/shared';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import styles from './dashboard.module.css';

interface ViewBarProps {
  dashboards: Dashboard[];
  activeId: string | null;
  editing: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (name: string) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}

function NameForm({
  label,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') {
      onSubmit(name.trim());
    }
  };
  return (
    <form className={styles.nameForm} onSubmit={submit}>
      <label className="sr-only" htmlFor={`view-name-${label}`}>
        {label}
      </label>
      <input id={`view-name-${label}`} value={name} onChange={(event) => setName(event.target.value)} />
      <button type="submit" className={styles.secondary}>
        {submitLabel}
      </button>
      {onCancel && (
        <button type="button" className={styles.secondary} onClick={onCancel}>
          Annuler
        </button>
      )}
    </form>
  );
}

export function ViewBar({
  dashboards,
  activeId,
  editing,
  onSelect,
  onCreate,
  onRename,
  onMove,
  onDelete,
}: ViewBarProps) {
  const [creating, setCreating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const active = dashboards.find((dashboard) => dashboard.id === activeId);
  const position = dashboards.findIndex((dashboard) => dashboard.id === activeId);

  return (
    <div className={styles.viewBar}>
      <div className={styles.tabs} role="group" aria-label="Vues du dashboard">
        {dashboards.map((dashboard) => (
          <button
            key={dashboard.id}
            type="button"
            className={dashboard.id === activeId ? styles.tabActive : styles.tab}
            aria-pressed={dashboard.id === activeId}
            onClick={() => {
              setConfirmingDelete(false);
              onSelect(dashboard.id);
            }}
          >
            {dashboard.name}
          </button>
        ))}
        <button type="button" className={styles.tab} onClick={() => setCreating(true)}>
          + Vue
        </button>
      </div>
      {creating && (
        <NameForm
          label="Nom de la nouvelle vue"
          initial=""
          submitLabel="Créer"
          onSubmit={(name) => {
            onCreate(name);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {editing && active && (
        <div className={styles.viewTools}>
          <NameForm
            key={active.id}
            label="Nom de la vue"
            initial={active.name}
            submitLabel="Renommer"
            onSubmit={onRename}
          />
          <button
            type="button"
            className={styles.secondary}
            aria-label="Déplacer la vue vers la gauche"
            disabled={position <= 0}
            onClick={() => onMove(-1)}
          >
            ←
          </button>
          <button
            type="button"
            className={styles.secondary}
            aria-label="Déplacer la vue vers la droite"
            disabled={position < 0 || position >= dashboards.length - 1}
            onClick={() => onMove(1)}
          >
            →
          </button>
          <button type="button" className={styles.secondary} onClick={() => setConfirmingDelete(true)}>
            Supprimer la vue
          </button>
          {confirmingDelete && (
            <ConfirmDialog
              title="Supprimer la vue"
              confirmLabel="Supprimer la vue"
              onConfirm={onDelete}
              onClose={() => setConfirmingDelete(false)}
            >
              La vue « {active.name} » et ses widgets seront supprimés.
            </ConfirmDialog>
          )}
        </div>
      )}
    </div>
  );
}
