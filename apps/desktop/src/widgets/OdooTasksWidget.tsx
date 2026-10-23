import { formatCalendarDay } from '../lib/format';
import type { OdooTasksData } from './data';
import { Big, Empty, Row, WidgetData, type NoConfig, type WidgetProps } from './parts';
import { useCacheWidget } from './use-widget-data';

export function OdooTasksWidget({ config }: WidgetProps<NoConfig>) {
  const state = useCacheWidget<OdooTasksData>('odoo_tasks', config, 'odoo');
  return (
    <WidgetData state={state}>
      {(data) => (
        <>
          <Big>{data.count} ouvertes</Big>
          {data.tasks.length === 0 && <Empty>Aucune tâche ouverte.</Empty>}
          {data.tasks.map((task) => (
            <Row
              key={task.id}
              label={task.title}
              value={task.dueDate === null ? '' : formatCalendarDay(task.dueDate)}
            />
          ))}
        </>
      )}
    </WidgetData>
  );
}
