import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './tabs.module.css';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
}

interface TabsProps<T extends string> {
  /** Préfixe unique des ids : `${idPrefix}-tab-${id}` et `${idPrefix}-panel-${id}`. */
  idPrefix: string;
  label: string;
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
}

function targetIndex(key: string, index: number, count: number): number {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return -1;
  }
}

/** Onglets accessibles au clavier (flèches, Début, Fin). */
export function Tabs<T extends string>({ idPrefix, label, items, value, onChange }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.id === value);
    const target = targetIndex(event.key, index, items.length);
    const item = items[target];
    if (item) {
      event.preventDefault();
      onChange(item.id);
      refs.current[target]?.focus();
    }
  };

  return (
    <div className={styles.tabs} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            className={selected ? styles.tabOn : styles.tab}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
