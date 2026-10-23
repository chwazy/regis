import type { Connector, ConnectorStatus } from '@regis/shared';
import { StatusPill } from '../../components/ui/StatusPill';
import { useTimezone } from '../../lib/use-timezone';
import styles from './connectors.module.css';
import {
  STATE_LABELS,
  STATE_TONES,
  authLabel,
  connectorInitials,
  lastSyncLabel,
  toolCountLabel,
  transportLabel,
} from './status';

interface ConnectorCardProps {
  connector: Connector;
  status: ConnectorStatus;
  selected: boolean;
  onSelect: () => void;
}

export function ConnectorCard({ connector, status, selected, onSelect }: ConnectorCardProps) {
  const timezone = useTimezone();
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={selected ? styles.cardSelected : styles.card}
      onClick={onSelect}
    >
      <span className={styles.cardHead}>
        <span className={styles.initials}>{connectorInitials(connector.name)}</span>
        <span className={styles.cardTitle}>
          <span className={styles.cardName}>{connector.name}</span>
          <span className={styles.mono}>{transportLabel(connector)}</span>
        </span>
        <StatusPill tone={STATE_TONES[status.state]} pulse={status.state === 'starting'}>
          {STATE_LABELS[status.state]}
        </StatusPill>
      </span>
      <span className={styles.cardMeta}>
        <span>{toolCountLabel(status.state === 'connected' ? status.toolCount : 0)}</span>
        <span>{authLabel(connector)}</span>
        <span>{lastSyncLabel(connector, timezone)}</span>
      </span>
    </button>
  );
}
