import type { JobEvent } from '@regis/shared';
import { formatClock } from '../../lib/format';
import { useTimezone } from '../../lib/use-timezone';
import { EVENT_KIND_LABELS, eventDetail, timelineSummaries } from './job-view';
import styles from './job.module.css';

interface JobTimelineProps {
  events: JobEvent[];
}

const KIND_CLASS: Record<JobEvent['type'], string> = {
  start: 'kindNeutral',
  message: 'kindNeutral',
  tool_call: 'kindTool',
  tool_result: 'kindTool',
  file: 'kindFile',
  approval_request: 'kindWait',
  approval_resolved: 'kindWait',
  end: 'kindNeutral',
  error: 'kindError',
};

export function JobTimeline({ events }: JobTimelineProps) {
  const timezone = useTimezone();
  const summaries = timelineSummaries(events);
  return (
    <section aria-label="Déroulé" className={styles.card}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Déroulé</h2>
        <span className={styles.muted}>événements structurés</span>
      </div>
      {events.length === 0 && <p className={styles.muted}>Aucun événement pour l’instant.</p>}
      <ol className={styles.steps}>
        {events.map((event, index) => {
          const detail = eventDetail(event);
          return (
            <li key={event.id} className={styles.step}>
              <span className={styles.stepTime}>{formatClock(event.at, timezone)}</span>
              <span className={`${styles.kind} ${styles[KIND_CLASS[event.type]] ?? ''}`}>
                {EVENT_KIND_LABELS[event.type]}
              </span>
              <div className={styles.stepBody}>
                <span>{summaries[index]}</span>
                {detail && <span className={styles.stepDetail}>{detail}</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
