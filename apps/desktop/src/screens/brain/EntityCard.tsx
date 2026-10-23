import { useState } from 'react';
import { Link } from 'react-router';
import type { EntityCard as EntityCardData, EntityKind } from '@regis/shared';
import controls from '../../components/ui/controls.module.css';
import { jobPath } from '../../lib/paths';
import { KIND_GROUPS, KIND_LABELS, entityInitials, entityTags, withTag, withoutTag } from './brain-view';
import { ActivityTabs } from './ActivityTabs';
import styles from './brain.module.css';
import { SynthesisSection } from './SynthesisSection';

interface EntityCardProps {
  card: EntityCardData;
  synthesisRequested: boolean;
  onDecideFact: (factId: string, status: 'confirmed' | 'rejected') => void;
  onChangeKind: (kind: EntityKind) => void;
  onChangeTags: (tags: string[]) => void;
  onRefreshSynthesis: () => void;
}

function emailOf(data: unknown): string | null {
  if (typeof data === 'object' && data !== null && 'email' in data && typeof data.email === 'string') {
    return data.email;
  }
  return null;
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const next = withTag(tags, draft);
    setDraft('');
    if (next !== tags) {
      onChange(next);
    }
  };

  return (
    <div className={styles.tags}>
      {tags.map((tag) => (
        <span key={tag} className={styles.tag}>
          #{tag}
          <button
            type="button"
            className={styles.tagRemove}
            aria-label={`Retirer le tag ${tag}`}
            onClick={() => onChange(withoutTag(tags, tag))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        aria-label="Ajouter un tag"
        className={styles.tagInput}
        placeholder="+ tag"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft.trim() !== '' && commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            setDraft('');
          }
        }}
      />
    </div>
  );
}

export function EntityCard({
  card,
  synthesisRequested,
  onDecideFact,
  onChangeKind,
  onChangeTags,
  onRefreshSynthesis,
}: EntityCardProps) {
  const { entity } = card;
  const email = emailOf(entity.dataJson);
  const activeJob = card.activeJobs.find((job) => job.kind !== 'synthesis');
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.avatar} aria-hidden="true">
          {entityInitials(entity.name)}
        </div>
        <div className={styles.headerText}>
          <h2 className={styles.name}>{entity.name}</h2>
          <div className={styles.metaRow}>
            <label className={styles.kindField}>
              <span className="sr-only">Changer de catégorie</span>
              <select
                className={controls.select}
                value={entity.kind}
                onChange={(event) => {
                  const picked = KIND_GROUPS.find((group) => group.kind === event.target.value);
                  if (picked && picked.kind !== entity.kind) {
                    onChangeKind(picked.kind);
                  }
                }}
              >
                {KIND_GROUPS.map((group) => (
                  <option key={group.kind} value={group.kind}>
                    {KIND_LABELS[group.kind]}
                  </option>
                ))}
              </select>
            </label>
            {email && <span className={styles.subline}>{email}</span>}
          </div>
          <TagEditor tags={entityTags(entity)} onChange={onChangeTags} />
        </div>
        {activeJob && (
          <div className={styles.headerActions}>
            <Link className={controls.secondary} to={jobPath(activeJob.id)}>
              Ouvrir la tâche en cours
            </Link>
          </div>
        )}
      </div>

      <SynthesisSection
        card={card}
        requested={synthesisRequested}
        onRefresh={onRefreshSynthesis}
        onDecideFact={onDecideFact}
      />

      <ActivityTabs card={card} />
    </div>
  );
}
