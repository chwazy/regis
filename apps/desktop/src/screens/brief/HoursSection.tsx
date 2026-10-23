import type { BriefData, HourSuggestion } from '@regis/shared';
import { formatHours, progressPercent, timesheetJobTitle } from './brief-view';
import styles from './brief.module.css';

interface HoursSectionProps {
  data: BriefData;
  submitted: ReadonlySet<string>;
  onSubmit: (suggestion: HourSuggestion) => void;
}

export function HoursSection({ data, submitted, onSubmit }: HoursSectionProps) {
  return (
    <section aria-label="Heures" className={styles.card}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Heures de la semaine</h2>
        <span className={styles.aside}>Odoo</span>
      </div>
      <div className={styles.hoursValue}>
        <span className={styles.hoursBig}>{formatHours(data.weekTotal)}</span>
        <span className={styles.muted}>sur {formatHours(data.weekTarget)}</span>
      </div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-label="Heures saisies sur l’objectif de la semaine"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent(data.weekTotal, data.weekTarget)}
      >
        <div
          className={styles.barFill}
          style={{ width: `${String(progressPercent(data.weekTotal, data.weekTarget))}%` }}
        />
      </div>
      {data.weekHours.map((row) => (
        <div key={row.projectName} className={styles.projectRow}>
          <span>{row.projectName}</span>
          <span className={styles.projectHours}>{formatHours(row.hours)}</span>
        </div>
      ))}
      {data.hourSuggestions.map((suggestion) => (
        <div key={suggestion.eventItemId} className={styles.suggestion}>
          <div className={styles.rowText}>
            <span className={styles.rowTitle}>{timesheetJobTitle(suggestion)}</span>
            <span className={styles.meta}>Déduit de l’agenda · {suggestion.description}</span>
          </div>
          <button
            type="button"
            className={`${styles.secondary} ${styles.suggestionAction}`}
            disabled={submitted.has(suggestion.eventItemId)}
            onClick={() => onSubmit(suggestion)}
          >
            {submitted.has(suggestion.eventItemId) ? 'Envoyé' : 'Saisir'}
          </button>
        </div>
      ))}
    </section>
  );
}
