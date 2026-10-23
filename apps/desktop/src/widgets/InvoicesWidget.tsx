import type { InvoicesData } from './data';
import { formatAmount } from './format';
import { Big, Row, WidgetData, type NoConfig, type WidgetProps } from './parts';
import { useCacheWidget } from './use-widget-data';

export function InvoicesWidget({ config }: WidgetProps<NoConfig>) {
  const state = useCacheWidget<InvoicesData>('invoices', config, 'odoo');
  return (
    <WidgetData state={state}>
      {(data) => (
        <>
          <Big>{formatAmount(data.outstandingAmount, data.currency)}</Big>
          <Row label="En retard" value={data.overdue} />
          <Row label="À émettre" value={data.toIssue} />
          <Row
            label="Payées ce mois"
            value={data.paidThisMonth}
            hint="Estimé d’après la dernière modification de la facture"
          />
        </>
      )}
    </WidgetData>
  );
}
