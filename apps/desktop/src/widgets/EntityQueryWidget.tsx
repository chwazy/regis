import type { EntityQueryData } from './data';
import { entityPath } from '../lib/paths';
import { useTimezone } from '../lib/use-timezone';
import { formatLastContact } from './format';
import { Big, Empty, Row, WidgetData, type WidgetProps } from './parts';
import { useCacheWidget } from './use-widget-data';

export interface EntityQueryConfig {
  days: number;
  kind: string;
}

export function EntityQueryWidget({ config }: WidgetProps<EntityQueryConfig>) {
  const state = useCacheWidget<EntityQueryData>('entity_query', config);
  const timezone = useTimezone();
  return (
    <WidgetData state={state}>
      {(data) => (
        <>
          <Big>{data.count} sans contact</Big>
          <Empty>Depuis plus de {data.days} jours.</Empty>
          {data.entities.map((entity) => (
            <Row
              key={entity.id}
              label={entity.name}
              value={formatLastContact(entity.lastContact, timezone)}
              to={entityPath(entity.id)}
            />
          ))}
        </>
      )}
    </WidgetData>
  );
}
