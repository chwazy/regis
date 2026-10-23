import type { WeekAgendaData } from './data';
import { formatWeekdayClock } from '../lib/format';
import { useTimezone } from '../lib/use-timezone';
import { Big, Empty, Row, WidgetData, type NoConfig, type WidgetProps } from './parts';
import { useCacheWidget } from './use-widget-data';

export function WeekAgendaWidget({ config }: WidgetProps<NoConfig>) {
  const state = useCacheWidget<WeekAgendaData>('week_agenda', config, ['m365']);
  const timezone = useTimezone();
  return (
    <WidgetData state={state}>
      {(data) => (
        <>
          <Big>{data.count} événements</Big>
          {data.events.length === 0 && <Empty>Rien à l’agenda dans les 7 prochains jours.</Empty>}
          {data.events.map((event) => (
            <Row key={event.id} label={event.title} value={formatWeekdayClock(event.startsAt, timezone)} />
          ))}
        </>
      )}
    </WidgetData>
  );
}
