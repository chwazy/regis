import ReactGridLayout, { useContainerWidth, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import type { Widget } from '@regis/shared';
import { WidgetBoundary } from '../../widgets/WidgetBoundary';
import { widgetDefinition } from '../../widgets/registry';
import styles from './dashboard.module.css';
import { applyLayout, GRID_COLUMNS, layoutDiffers, toLayout } from './layout';

const ROW_HEIGHT = 60;
const GAP = 16;
const DRAG_HANDLE_CLASS = 'widget-drag-handle';
/** Ancien titre par défaut du widget des tâches, déjà enregistré dans les vues existantes. */
const LEGACY_JOBS_TITLE = 'Jobs agents';

interface GridProps {
  widgets: Widget[];
  editing: boolean;
  onLayoutChange: (widgets: Widget[]) => void;
  onRemove: (widget: Widget) => void;
}

function WidgetCard({
  widget,
  editing,
  onRemove,
}: {
  widget: Widget;
  editing: boolean;
  onRemove: () => void;
}) {
  const definition = widgetDefinition(widget.kind);
  const title =
    widget.kind === 'jobs' && widget.title === LEGACY_JOBS_TITLE
      ? (definition?.title ?? widget.title)
      : widget.title;
  return (
    <section aria-label={title} className={`${styles.card} ${editing ? styles.cardEditing : ''}`}>
      <div className={styles.cardHead}>
        {editing && (
          <span
            className={`${styles.handle} ${DRAG_HANDLE_CLASS}`}
            role="img"
            aria-label={`Déplacer ${title}`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="9" cy="6" r="1" />
              <circle cx="15" cy="6" r="1" />
              <circle cx="9" cy="12" r="1" />
              <circle cx="15" cy="12" r="1" />
              <circle cx="9" cy="18" r="1" />
              <circle cx="15" cy="18" r="1" />
            </svg>
          </span>
        )}
        <h2 className={styles.cardTitle}>{title}</h2>
        {definition && <span className={styles.source}>{definition.source}</span>}
        {editing && (
          <button
            type="button"
            className={styles.remove}
            aria-label={`Supprimer ${title}`}
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </div>
      <div className={styles.cardBody}>
        <WidgetBoundary>
          {definition ? (
            <definition.Component config={widget.configJson} widgetId={widget.id} />
          ) : (
            <p className={styles.unknown}>Type de widget inconnu : {widget.kind}</p>
          )}
        </WidgetBoundary>
      </div>
    </section>
  );
}

export function Grid({ widgets, editing, onLayoutChange, onRemove }: GridProps) {
  const { width, containerRef, mounted } = useContainerWidth();
  const layout = toLayout(widgets, (kind) => widgetDefinition(kind)?.minSize);

  const handleLayoutChange = (next: Layout) => {
    if (!editing) {
      return;
    }
    const merged = applyLayout(widgets, next);
    if (layoutDiffers(widgets, merged)) {
      onLayoutChange(merged);
    }
  };

  return (
    <div ref={containerRef} className={styles.grid}>
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={layout}
          gridConfig={{
            cols: GRID_COLUMNS,
            rowHeight: ROW_HEIGHT,
            margin: [GAP, GAP],
            containerPadding: [0, 0],
          }}
          dragConfig={{ enabled: editing, handle: `.${DRAG_HANDLE_CLASS}` }}
          resizeConfig={{ enabled: editing }}
          onLayoutChange={handleLayoutChange}
        >
          {widgets.map((widget) => (
            <div key={widget.id}>
              <WidgetCard widget={widget} editing={editing} onRemove={() => onRemove(widget)} />
            </div>
          ))}
        </ReactGridLayout>
      )}
    </div>
  );
}
