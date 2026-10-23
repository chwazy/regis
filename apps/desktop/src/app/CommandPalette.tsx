import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { GlobalSearchResult } from '@regis/shared';
import { errorMessage } from '../lib/format';
import { invokeCmd } from '../lib/ipc';
import { useUiScreens } from '../lib/use-ui-screens';
import { ErrorMessage } from '../components/ui/Feedback';
import { NAV_ITEMS, SETTINGS_ITEMS } from './routes';
import styles from './CommandPalette.module.css';
import {
  GROUP_LABELS,
  OPEN_PALETTE_EVENT,
  groupedEntries,
  isPaletteShortcut,
  matchPages,
  moveSelection,
  pageSuggestions,
  paletteEntries,
  type PaletteEntry,
  type PalettePage,
} from './palette-model';

const SEARCH_DELAY_MS = 150;

const EMPTY_RESULT: GlobalSearchResult = { entities: [], documents: [], mails: [], notes: [] };

export function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isPaletteShortcut(event)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    const onOpenRequest = () => setOpen(true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenRequest);
    };
  }, []);

  return open ? <PaletteDialog onClose={() => setOpen(false)} /> : null;
}

function usePalettePages(): PalettePage[] {
  const { screens } = useUiScreens();
  return useMemo(
    () => [
      ...NAV_ITEMS.filter((item) => item.screen === undefined || screens[item.screen]).map((item) => ({
        label: item.label,
        to: item.to,
        detail: 'Page',
      })),
      ...SETTINGS_ITEMS.map((item) => ({ label: item.label, to: item.to, detail: 'Réglages' })),
    ],
    [screens],
  );
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<GlobalSearchResult>(EMPTY_RESULT);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const hasQuery = query.trim() !== '';
  const pages = usePalettePages();
  const entries = useMemo(
    () => (hasQuery ? [...matchPages(pages, query), ...paletteEntries(found)] : pageSuggestions(pages)),
    [found, hasQuery, pages, query],
  );
  const sections = useMemo(() => groupedEntries(entries), [entries]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    if (!hasQuery) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      invokeCmd<GlobalSearchResult>('global_search', { q: query })
        .then((result) => {
          if (!cancelled) {
            setFound(result);
            setError(null);
          }
        })
        .catch((reason: unknown) => {
          if (!cancelled) {
            setFound(EMPTY_RESULT);
            setError(errorMessage(reason));
          }
        });
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hasQuery, query]);

  const choose = (entry: PaletteEntry | undefined) => {
    if (entry) {
      onClose();
      void navigate(entry.path);
    }
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((current) => moveSelection(current, 1, entries.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((current) => moveSelection(current, -1, entries.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(entries[selected]);
    }
  };

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Recherche"
        className={styles.panel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          aria-label="Rechercher une page, un client, un projet"
          className={styles.input}
          placeholder="Rechercher une page, un client, un projet…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onInputKeyDown}
        />
        <ErrorMessage>{error}</ErrorMessage>
        <div className={styles.results}>
          {hasQuery && entries.length === 0 && !error && <p className={styles.empty}>Aucun résultat.</p>}
          {sections.map((section) => (
            <section key={section.group} aria-label={GROUP_LABELS[section.group]}>
              <h2 className={styles.groupTitle}>{GROUP_LABELS[section.group]}</h2>
              {section.entries.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={entries[selected]?.key === entry.key ? styles.resultActive : styles.result}
                  onMouseEnter={() => setSelected(entries.indexOf(entry))}
                  onClick={() => choose(entry)}
                >
                  <span className={styles.resultLabel}>{entry.label}</span>
                  <span className={styles.resultDetail}>{entry.detail}</span>
                </button>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
