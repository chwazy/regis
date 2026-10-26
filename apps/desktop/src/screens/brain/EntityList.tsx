import { useMemo, useState } from 'react';
import type { EntitySummary } from '@regis/shared';
import { ErrorMessage } from '../../components/ui/Feedback';
import controls from '../../components/ui/controls.module.css';
import { allTags, groupEntities } from './brain-view';
import styles from './brain.module.css';

interface EntityListProps {
  entities: EntitySummary[];
  selectedId: string | null;
  query: string;
  error: string | null;
  onQueryChange: (query: string) => void;
  onSelect: (id: string) => void;
}

export function EntityList({ entities, selectedId, query, error, onQueryChange, onSelect }: EntityListProps) {
  const [tag, setTag] = useState<string | null>(null);
  const tags = useMemo(() => allTags(entities), [entities]);
  const activeTag = tag !== null && tags.includes(tag) ? tag : null;
  const groups = groupEntities(entities, activeTag);

  return (
    <aside aria-label="Entités" className={styles.list}>
      <input
        aria-label="Filtrer les entités"
        className={styles.searchInput}
        type="search"
        placeholder="Rechercher…"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {tags.length > 0 && (
        <div className={styles.filters} aria-label="Filtrer par tag" role="group">
          {tags.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={activeTag === candidate}
              className={activeTag === candidate ? controls.chipOn : controls.chip}
              onClick={() => setTag(activeTag === candidate ? null : candidate)}
            >
              #{candidate}
            </button>
          ))}
        </div>
      )}
      <ErrorMessage>{error}</ErrorMessage>
      <div className={styles.entities}>
        {groups.map((group) => (
          <section key={group.kind} aria-label={group.label} className={styles.group}>
            <h2 className={styles.groupTitle}>
              {group.label}
              <span className={styles.groupCount}>{group.entities.length}</span>
            </h2>
            {group.entities.map(({ entity, meta }) => (
              <button
                key={entity.id}
                type="button"
                aria-current={entity.id === selectedId ? 'true' : undefined}
                className={entity.id === selectedId ? styles.entityRowActive : styles.entityRow}
                onClick={() => onSelect(entity.id)}
              >
                <span className={styles.entityName}>{entity.name}</span>
                {meta && <span className={styles.entityMeta}>{meta}</span>}
              </button>
            ))}
          </section>
        ))}
        {groups.length === 0 && !error && <p className={styles.empty}>Aucune entité.</p>}
      </div>
    </aside>
  );
}
