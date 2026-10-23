import { Link } from 'react-router';
import type { FactStatus, FactView } from '@regis/shared';
import { ROUTES } from '../../app/routes';
import controls from '../../components/ui/controls.module.css';
import { StatusPill, type PillTone } from '../../components/ui/StatusPill';
import { FACT_STATUS_LABELS, factSourceLabel, factSourceTarget, type FactSourceTarget } from './brain-view';
import styles from './brain.module.css';

interface FactsSectionProps {
  facts: FactView[];
  onDecide: (factId: string, status: 'confirmed' | 'rejected') => void;
}

function scrollToAnchor(anchor: string): void {
  const element = document.getElementById(anchor);
  if (element) {
    window.location.hash = anchor;
    element.scrollIntoView({ block: 'center' });
  }
}

const STATUS_TONES: Record<FactStatus, PillTone> = {
  confirmed: 'ok',
  to_verify: 'warn',
  inferred: 'muted',
};

function SourceLink({ label, target }: { label: string; target: FactSourceTarget | null }) {
  if (target === null) {
    return <span className={styles.factSourcePlain}>{label}</span>;
  }
  if (target.type === 'timeline') {
    return (
      <a
        className={styles.factSource}
        href={`#${target.anchor}`}
        onClick={(event) => {
          event.preventDefault();
          scrollToAnchor(target.anchor);
        }}
      >
        {label}
      </a>
    );
  }
  return (
    <Link className={styles.factSource} to={target.type === 'job' ? target.path : ROUTES.sources}>
      {label}
    </Link>
  );
}

export function FactsSection({ facts, onDecide }: FactsSectionProps) {
  return (
    <section id="faits-sources" aria-label="Faits sourcés" className={styles.factsPanel}>
      <div className={styles.sectionHead}>
        <h3 className={styles.subTitle}>Faits sourcés</h3>
        <span className={styles.sectionHint}>extraits automatiquement · chaque fait cite sa source</span>
      </div>
      {facts.length === 0 && <p className={styles.empty}>Aucun fait pour l’instant.</p>}
      {facts.map(({ fact, source }) => (
        <div key={fact.id} className={styles.fact}>
          <span className={styles.factText}>{fact.text}</span>
          <SourceLink label={factSourceLabel(source)} target={factSourceTarget(source)} />
          <StatusPill tone={STATUS_TONES[fact.status]}>{FACT_STATUS_LABELS[fact.status]}</StatusPill>
          <span className={styles.factActions}>
            {fact.status !== 'confirmed' && (
              <button
                type="button"
                className={controls.secondarySm}
                onClick={() => onDecide(fact.id, 'confirmed')}
              >
                Confirmer
              </button>
            )}
            <button type="button" className={controls.dangerSm} onClick={() => onDecide(fact.id, 'rejected')}>
              Rejeter
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}
