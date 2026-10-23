import { Link } from 'react-router';
import type { Brief, BriefData, BriefSections } from '@regis/shared';
import { jobPath } from '../../lib/paths';
import { deterministicHeadline, formatBriefDate } from './brief-view';
import styles from './brief.module.css';

interface SummaryProps {
  data: BriefData;
  brief: Brief | null;
  regenerating: boolean;
  onRegenerate: () => void;
  onChip: (text: string) => void;
}

function readSections(brief: Brief | null): BriefSections {
  const raw = brief?.sectionsJson as Partial<BriefSections> | null | undefined;
  return {
    priorities: Array.isArray(raw?.priorities) ? raw.priorities : [],
    quickActions: Array.isArray(raw?.quickActions) ? raw.quickActions : [],
  };
}

function refTarget(ref: { type: string; id: string } | undefined): string | null {
  return ref?.type === 'job' ? jobPath(ref.id) : null;
}

export function Summary({ data, brief, regenerating, onRegenerate, onChip }: SummaryProps) {
  const sections = readSections(brief);
  return (
    <section aria-label="Résumé" className={styles.summary}>
      <span className={styles.date}>{formatBriefDate(data.date)} · bonjour</span>
      <h1 className={styles.headline}>{brief?.headline ?? deterministicHeadline(data)}</h1>
      {sections.priorities.length > 0 && (
        <ul className={styles.priorities} aria-label="Priorités">
          {sections.priorities.map((priority) => {
            const target = refTarget(priority.ref);
            return (
              <li key={`${priority.text}-${priority.ref?.id ?? ''}`}>
                {target ? <Link to={target}>{priority.text}</Link> : priority.text}
              </li>
            );
          })}
        </ul>
      )}
      {sections.quickActions.length > 0 && (
        <div className={styles.chips}>
          {sections.quickActions.map((action) => (
            <button key={action} type="button" className={styles.chip} onClick={() => onChip(action)}>
              {action}
            </button>
          ))}
        </div>
      )}
      <div className={styles.tools}>
        <button type="button" className={styles.regenerate} disabled={regenerating} onClick={onRegenerate}>
          {regenerating ? 'Génération…' : brief ? 'Régénérer' : 'Générer le brief'}
        </button>
      </div>
    </section>
  );
}
