import type { Item } from '@regis/shared';
import { JoinMeetingButton } from '../../components/JoinMeetingButton';
import { eventMeta, formatTime } from './brief-view';
import styles from './brief.module.css';

interface AgendaSectionProps {
  events: Item[];
  timezone: string;
}

export function AgendaSection({ events, timezone }: AgendaSectionProps) {
  return (
    <section aria-label="Agenda" className={styles.card}>
      <h2 className={styles.cardTitle}>Aujourd’hui</h2>
      {events.length === 0 && <p className={styles.empty}>Aucun événement aujourd’hui.</p>}
      <ul className={styles.list}>
        {events.map((event) => (
          <li key={event.id} className={styles.row}>
            <span className={styles.time}>{formatTime(event.occurredAt, timezone)}</span>
            <div className={styles.rowText}>
              <span className={styles.rowTitle}>{event.title}</span>
              <span className={styles.meta}>{eventMeta(event)}</span>
            </div>
            <JoinMeetingButton event={event} />
          </li>
        ))}
      </ul>
    </section>
  );
}
