import { useCallback, useEffect, useState } from 'react';
import type { Dashboard, Widget } from '@regis/shared';
import { PageHeader } from '../../components/ui/PageHeader';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/format';
import { invokeCmd } from '../../lib/ipc';
import { Catalog, type NewWidgetDraft } from './Catalog';
import { Grid } from './Grid';
import { ViewBar } from './ViewBar';
import styles from './dashboard.module.css';
import { placeNewWidget, type Size } from './layout';

function reorderedPair(
  dashboards: Dashboard[],
  activeId: string,
  delta: -1 | 1,
): [Dashboard, Dashboard] | null {
  const index = dashboards.findIndex((dashboard) => dashboard.id === activeId);
  const current = dashboards[index];
  const neighbour = dashboards[index + delta];
  if (current === undefined || neighbour === undefined) {
    return null;
  }
  return [
    { ...current, ord: neighbour.ord },
    { ...neighbour, ord: current.ord },
  ];
}

export default function DashboardScreen() {
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [editing, setEditing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback((reason: unknown) => setError(errorMessage(reason)), []);

  const loadDashboards = useCallback(
    (preferredId?: string): Promise<void> =>
      invokeCmd<Dashboard[]>('list_dashboards').then((listed) => {
        setDashboards(listed);
        setActiveId((current) => {
          const wanted = preferredId ?? current;
          return listed.some((dashboard) => dashboard.id === wanted) ? wanted : (listed[0]?.id ?? null);
        });
        setLoaded(true);
      }),
    [],
  );

  useEffect(() => {
    loadDashboards().catch(fail);
  }, [loadDashboards, fail]);

  useEffect(() => {
    if (activeId === null) {
      return;
    }
    let cancelled = false;
    invokeCmd<Widget[]>('list_widgets', { dashboardId: activeId })
      .then((listed) => {
        if (!cancelled) {
          setWidgets(listed);
        }
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [activeId, fail]);

  const active = dashboards.find((dashboard) => dashboard.id === activeId);

  const selectView = (id: string) => {
    if (!editing || activeId === null || id === activeId) {
      setActiveId(id);
      return;
    }
    invokeCmd<Widget[]>('save_widgets', { dashboardId: activeId, widgets })
      .then(() => setActiveId(id))
      .catch(fail);
  };

  const createView = (name: string) => {
    setEditing(true);
    invokeCmd<Dashboard>('save_dashboard', { dashboard: { id: '', name, ord: 0 } })
      .then((created) => loadDashboards(created.id))
      .catch(fail);
  };

  const renameView = (name: string) => {
    if (active === undefined) {
      return;
    }
    invokeCmd<Dashboard>('save_dashboard', { dashboard: { ...active, name } })
      .then(() => loadDashboards())
      .catch(fail);
  };

  const moveView = (delta: -1 | 1) => {
    const pair = activeId === null ? null : reorderedPair(dashboards, activeId, delta);
    if (pair === null) {
      return;
    }
    Promise.all(pair.map((dashboard) => invokeCmd<Dashboard>('save_dashboard', { dashboard })))
      .then(() => loadDashboards())
      .catch(fail);
  };

  const deleteView = () => {
    if (activeId === null) {
      return;
    }
    setEditing(false);
    invokeCmd('delete_dashboard', { id: activeId })
      .then(() => {
        setWidgets([]);
        setActiveId(null);
        return loadDashboards();
      })
      .catch(fail);
  };

  const finishEditing = () => {
    if (activeId === null) {
      setEditing(false);
      return;
    }
    invokeCmd<Widget[]>('save_widgets', { dashboardId: activeId, widgets })
      .then((saved) => {
        setWidgets(saved);
        setEditing(false);
      })
      .catch(fail);
  };

  const addWidget = (draft: NewWidgetDraft, size: Size) => {
    if (activeId === null) {
      return;
    }
    const placed = placeNewWidget(widgets, activeId, draft, size);
    invokeCmd<Widget[]>('save_widgets', { dashboardId: activeId, widgets: [...widgets, placed] })
      .then(setWidgets)
      .catch(fail);
  };

  const removeWidget = (widget: Widget) => {
    invokeCmd('delete_widget', { id: widget.id })
      .then(() => setWidgets((current) => current.filter((candidate) => candidate.id !== widget.id)))
      .catch(fail);
  };

  return (
    <div className={styles.layout}>
      <div className={styles.content}>
        <PageHeader
          title="Dashboard"
          actions={
            <>
              {editing && <span className={styles.hint}>Mode édition — glisse pour réorganiser</span>}
              <button
                type="button"
                className={editing ? styles.primary : styles.secondary}
                onClick={editing ? finishEditing : () => setEditing(true)}
                disabled={active === undefined && !editing}
              >
                {editing ? 'Terminer' : 'Modifier'}
              </button>
            </>
          }
        />
        <ViewBar
          dashboards={dashboards}
          activeId={activeId}
          editing={editing}
          onSelect={selectView}
          onCreate={createView}
          onRename={renameView}
          onMove={moveView}
          onDelete={deleteView}
        />
        <ErrorMessage>{error}</ErrorMessage>
        {!loaded && error === null && <Loading />}
        {loaded && active === undefined && (
          <p className={styles.muted}>Aucune vue. Crée-en une avec « + Vue ».</p>
        )}
        {active !== undefined && (
          <Grid widgets={widgets} editing={editing} onLayoutChange={setWidgets} onRemove={removeWidget} />
        )}
      </div>
      {editing && active !== undefined && <Catalog onAdd={addWidget} />}
    </div>
  );
}
