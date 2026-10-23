import type { HoursByProjectData } from './data';
import { formatHours } from '../lib/format';
import { Big, Empty, Row, WidgetData, type NoConfig, type WidgetProps } from './parts';
import { useCacheWidget } from './use-widget-data';

export function HoursByProjectWidget({ config }: WidgetProps<NoConfig>) {
  const state = useCacheWidget<HoursByProjectData>('hours_by_project', config, 'odoo');
  return (
    <WidgetData state={state}>
      {(data) => (
        <>
          <Big>{formatHours(data.total)}</Big>
          {data.projects.length === 0 && <Empty>Aucune heure saisie cette semaine.</Empty>}
          {data.projects.map((project) => (
            <Row key={project.projectName} label={project.projectName} value={formatHours(project.hours)} />
          ))}
        </>
      )}
    </WidgetData>
  );
}
