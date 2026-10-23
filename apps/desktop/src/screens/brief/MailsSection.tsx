import type { Item } from '@regis/shared';
import { MAX_MAILS_SHOWN, formatMailTime, initialsOf, senderOf } from './brief-view';
import styles from './brief.module.css';

interface MailsSectionProps {
  mails: Item[];
  now: Date;
  timezone: string;
}

export function MailsSection({ mails, now, timezone }: MailsSectionProps) {
  return (
    <section aria-label="Mails" className={styles.card}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Mails importants</h2>
        <span className={styles.badge}>{mails.length}</span>
      </div>
      {mails.length === 0 && <p className={styles.empty}>Aucun mail non lu ces 48 dernières heures.</p>}
      <ul className={styles.list}>
        {mails.slice(0, MAX_MAILS_SHOWN).map((mail) => {
          const sender = senderOf(mail);
          return (
            <li key={mail.id} className={styles.row}>
              <div className={styles.avatar} aria-hidden="true">
                {initialsOf(sender)}
              </div>
              <div className={styles.rowText}>
                <span className={styles.rowTitle}>{mail.title}</span>
                <span className={styles.meta}>
                  {sender} · {formatMailTime(mail.occurredAt, now, timezone)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
