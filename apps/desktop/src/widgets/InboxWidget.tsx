import type { InboxData } from './data';
import { Big, Row, WidgetData, type NoConfig, type WidgetProps } from './parts';
import { useCacheWidget } from './use-widget-data';

export function InboxWidget({ config }: WidgetProps<NoConfig>) {
  const state = useCacheWidget<InboxData>('inbox', config, ['m365']);
  return (
    <WidgetData state={state}>
      {(data) => (
        <>
          <Big>{data.unread} non lus</Big>
          <Row label="Prioritaires" value={data.priority} />
          <Row label="Attendent ma réponse" value={data.awaitingReply} />
        </>
      )}
    </WidgetData>
  );
}
