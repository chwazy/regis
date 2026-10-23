import { customWithinDayOffsets, type CustomWidgetData, type CustomWidgetSpec } from '@regis/shared';
import { localMidnightUtc, shiftCalendarDay } from './format';
import { Big, Empty, Row, WidgetData, type WidgetProps } from './parts';
import { useCacheWidget } from './use-widget-data';
import styles from './widgets.module.css';

const PERCENT = 100;

export function formatCustomValue(value: number): string {
  return new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 2 }).format(value);
}

export function barPercent(value: number, rows: { value: number }[]): number {
  const max = Math.max(0, ...rows.map((row) => row.value));
  return max === 0 ? 0 : Math.round((Math.max(0, value) / max) * PERCENT);
}

function CustomRows({ data, render }: { data: CustomWidgetData; render: CustomWidgetSpec['render'] }) {
  if (data.rows.length === 0) {
    return <Empty>Aucun résultat.</Empty>;
  }
  if (render === 'bar') {
    return data.rows.map((row) => (
      <div key={row.label} className={styles.barRow}>
        <div className={styles.barHead}>
          <span className={styles.rowLabel}>{row.label}</span>
          <span className={styles.rowValue}>{formatCustomValue(row.value)}</span>
        </div>
        <div className={styles.barTrack} aria-hidden="true">
          <div className={styles.barFill} style={{ width: `${String(barPercent(row.value, data.rows))}%` }} />
        </div>
      </div>
    ));
  }
  return (
    <>
      {render === 'kv' && <Big>{formatCustomValue(data.total)}</Big>}
      {data.rows.map((row) => (
        <Row key={row.label} label={row.label} value={formatCustomValue(row.value)} />
      ))}
    </>
  );
}

export function CustomWidget({ config }: WidgetProps<CustomWidgetSpec>) {
  const state = useCacheWidget<CustomWidgetData>('custom', config, undefined, ({ today, timezone }) => ({
    dayStarts: Object.fromEntries(
      customWithinDayOffsets(config.filters).map((offset) => [
        String(offset),
        localMidnightUtc(shiftCalendarDay(today, offset), timezone),
      ]),
    ),
  }));
  return <WidgetData state={state}>{(data) => <CustomRows data={data} render={config.render} />}</WidgetData>;
}
