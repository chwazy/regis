import { useState } from 'react';
import type { EntityCard } from '@regis/shared';
import controls from '../../components/ui/controls.module.css';
import { useTimezone } from '../../lib/use-timezone';
import { isSynthesizing, relativeAge, statChips } from './brain-view';
import styles from './brain.module.css';
import { FactsSection } from './FactsSection';

interface SynthesisSectionProps {
  card: EntityCard;
  requested: boolean;
  onRefresh: () => void;
  onDecideFact: (factId: string, status: 'confirmed' | 'rejected') => void;
}

export function SynthesisSection({ card, requested, onRefresh, onDecideFact }: SynthesisSectionProps) {
  const timezone = useTimezone();
  const [showFacts, setShowFacts] = useState(false);
  const { synthesis } = card;
  const generating = requested || isSynthesizing(card);
  const chips = statChips(card, timezone);

  return (
    <section aria-label="Synthèse" className={styles.synthesis}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Synthèse</h2>
        <span className={styles.synthesisMeta}>
          {generating
            ? 'mise à jour en cours…'
            : synthesis
              ? `agent local · mise à jour ${relativeAge(synthesis.generatedAt, new Date())}`
              : 'agent local'}
        </span>
        <button type="button" className={controls.secondarySm} disabled={generating} onClick={onRefresh}>
          Actualiser
        </button>
      </div>

      {synthesis ? (
        <p className={styles.synthesisText}>{synthesis.text}</p>
      ) : (
        <p className={styles.empty}>
          {generating
            ? 'L’agent local rédige la synthèse…'
            : 'Pas encore de synthèse. Elle sera générée au prochain passage de l’agent local.'}
        </p>
      )}

      {chips.length > 0 && (
        <ul className={styles.statChips} aria-label="Chiffres issus des données">
          {chips.map((chip) => (
            <li key={chip} className={styles.statChip}>
              {chip}
            </li>
          ))}
        </ul>
      )}

      <div className={styles.synthesisFoot}>
        {synthesis && synthesis.sourceCount > 0 && (
          <span>
            Basée sur {synthesis.sourceCount} source{synthesis.sourceCount > 1 ? 's' : ''}
          </span>
        )}
        <button
          type="button"
          className={controls.link}
          aria-expanded={showFacts}
          aria-controls="faits-sources"
          onClick={() => setShowFacts((shown) => !shown)}
        >
          {showFacts
            ? 'Masquer les faits sourcés'
            : `Afficher les faits sourcés (${String(card.facts.length)})`}
        </button>
      </div>

      {showFacts && <FactsSection facts={card.facts} onDecide={onDecideFact} />}
    </section>
  );
}
