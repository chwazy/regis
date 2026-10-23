import { sidecarCall } from '../lib/ipc';
import { toKeyValueRows, type KeyValueRow } from './format';
import { Empty, Row, WidgetData, type WidgetProps } from './parts';
import { useWidgetData } from './use-widget-data';

export const DEFAULT_MCP_REFRESH_MINUTES = 5;

export interface McpToolConfig {
  connectorId: string;
  tool: string;
  args: Record<string, unknown>;
  refreshMinutes: number;
}

export function McpToolWidget({ config }: WidgetProps<McpToolConfig>) {
  const configured = config.connectorId !== '' && config.tool !== '';
  const state = useWidgetData<KeyValueRow[]>(
    async () => {
      if (!configured) {
        return [];
      }
      const result = await sidecarCall<unknown>('widgets.mcpTool', {
        connectorId: config.connectorId,
        tool: config.tool,
        args: config.args,
      });
      return toKeyValueRows(result);
    },
    JSON.stringify(config),
    { refreshOnSync: false, refreshMinutes: configured ? config.refreshMinutes : undefined },
  );
  if (!configured) {
    return <Empty>Widget non configuré.</Empty>;
  }
  return (
    <WidgetData state={state}>
      {(rows) => (
        <>
          {rows.length === 0 && <Empty>Aucun résultat.</Empty>}
          {rows.map((row) => (
            <Row key={row.key} label={row.key} value={row.value} />
          ))}
        </>
      )}
    </WidgetData>
  );
}
