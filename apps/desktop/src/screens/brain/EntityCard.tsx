import { Link } from 'react-router';
import type { EntityCard as EntityCardData } from '@regis/shared';
import controls from '../../components/ui/controls.module.css';
import { jobPath } from '../../lib/paths';
import { KIND_LABELS, entityInitials, entityTags } from './brain-view';
import { ActivityTabs } from './ActivityTabs';
import styles from './brain.module.css';
import { SynthesisSection } from './SynthesisSection';

interface EntityCardProps {
  card: EntityCardData;
  synthesisRequested: boolean;
  onDecideFact: (factId: string, status: 'confirmed' | 'rejected') => void;
  onRefreshSynthesis: () => void;
}

function emailOf(data: unknown): string | null {
  if (typeof data === 'object' && data !== null && 'email' in data && typeof data.email === 'string') {
    return data.email;
  }
  return null;
}

export function EntityCard({ card, synthesisRequested, onDecideFact, onRefreshSynthesis }: EntityCardProps) {
  const { entity } = card;
  const email = emailOf(entity.dataJson);
  const tags = entityTags(entity);
  const activeJob = card.activeJobs.find((job) => job.kind !== 'synthesis');
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.avatar} aria-hidden="true">
          {entityInitials(entity.name)}
        </div>
        <div className={styles.headerText}>
          <h2 className={styles.name}>{entity.name}</h2>
          <div className={styles.metaRow}>
            <span className={styles.timelineKind}>{KIND_LABELS[entity.kind]}</span>
            {email && <span className={styles.subline}>{email}</span>}
          </div>
          {tags.length > 0 && (
            <div className={styles.tags}>
              {tags.map((tag) => (
                <span key={tag} className={styles.tag}>
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
        {activeJob && (
          <div className={styles.headerActions}>
            <Link className={controls.secondary} to={jobPath(activeJob.id)}>
              Ouvrir la tâche en cours
            </Link>
          </div>
        )}
      </div>

      <SynthesisSection
        card={card}
        requested={synthesisRequested}
        onRefresh={onRefreshSynthesis}
        onDecideFact={onDecideFact}
      />

      <ActivityTabs card={card} />
    </div>
  );
}
