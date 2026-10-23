import type { RecentFilesData } from './data';
import { formatDay } from '../lib/format';
import { useTimezone } from '../lib/use-timezone';
import { fileName } from './format';
import { Big, Empty, Row, WidgetData, type NoConfig, type WidgetProps } from './parts';
import { useCacheWidget } from './use-widget-data';

export function RecentFilesWidget({ config }: WidgetProps<NoConfig>) {
  const state = useCacheWidget<RecentFilesData>('recent_files', config);
  const timezone = useTimezone();
  return (
    <WidgetData state={state}>
      {(data) => (
        <>
          <Big>{data.files.length} fichiers</Big>
          {data.files.length === 0 && <Empty>Aucun fichier indexé.</Empty>}
          {data.files.map((file) => (
            <Row key={file.id} label={fileName(file.relPath)} value={formatDay(file.modifiedAt, timezone)} />
          ))}
        </>
      )}
    </WidgetData>
  );
}
