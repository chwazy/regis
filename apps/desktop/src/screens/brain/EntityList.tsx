import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntityKind, EntitySummary } from '@regis/shared';
import { ErrorMessage } from '../../components/ui/Feedback';
import controls from '../../components/ui/controls.module.css';
import { KIND_GROUPS, KIND_LABELS, allTags, groupEntities } from './brain-view';
import styles from './brain.module.css';

interface EntityListProps {
  entities: EntitySummary[];
  selectedId: string | null;
  query: string;
  error: string | null;
  onQueryChange: (query: string) => void;
  onSelect: (id: string) => void;
  onChangeKind: (id: string, kind: EntityKind) => void;
}

const MENU_WIDTH = 180;
const MENU_HEIGHT = 190;

interface KindMenuState {
  entityId: string;
  kind: EntityKind;
  x: number;
  y: number;
}

function KindMenu({
  menu,
  onPick,
  onClose,
}: {
  menu: KindMenuState;
  onPick: (kind: EntityKind) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const closeOnOutside = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Catégorie"
      className={styles.contextMenu}
      style={{ left: menu.x, top: menu.y }}
    >
      <span className={styles.contextMenuTitle}>Catégorie</span>
      {KIND_GROUPS.map((group) => (
        <button
          key={group.kind}
          type="button"
          role="menuitemradio"
          aria-checked={menu.kind === group.kind}
          className={styles.contextMenuItem}
          onClick={() => onPick(group.kind)}
        >
          {KIND_LABELS[group.kind]}
        </button>
      ))}
    </div>
  );
}

export function EntityList({
  entities,
  selectedId,
  query,
  error,
  onQueryChange,
  onSelect,
  onChangeKind,
}: EntityListProps) {
  const [tag, setTag] = useState<string | null>(null);
  const [menu, setMenu] = useState<KindMenuState | null>(null);
  const closeMenu = useMemo(() => () => setMenu(null), []);
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
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({
                    entityId: entity.id,
                    kind: entity.kind,
                    x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH),
                    y: Math.min(event.clientY, window.innerHeight - MENU_HEIGHT),
                  });
                }}
              >
                <span className={styles.entityName}>{entity.name}</span>
                {meta && <span className={styles.entityMeta}>{meta}</span>}
              </button>
            ))}
          </section>
        ))}
        {groups.length === 0 && !error && <p className={styles.empty}>Aucune entité.</p>}
      </div>
      {menu && (
        <KindMenu
          menu={menu}
          onClose={closeMenu}
          onPick={(kind) => {
            setMenu(null);
            if (kind !== menu.kind) {
              onChangeKind(menu.entityId, kind);
            }
          }}
        />
      )}
    </aside>
  );
}
