import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { EntityCard as EntityCardData, EntitySummary } from '@regis/shared';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import controls from '../../components/ui/controls.module.css';
import { PageHeader } from '../../components/ui/PageHeader';
import { errorMessage } from '../../lib/format';
import { invokeCmd, onRegisEvent, sidecarCall } from '../../lib/ipc';
import { useModuleOn } from '../../lib/use-local-modules';
import { resolveSelection, settleSynthesisRequest, type SynthesisRequest } from './brain-view';
import styles from './brain.module.css';
import { EntityCard } from './EntityCard';
import { EntityList } from './EntityList';
import { NewRecordingDialog } from './NewRecordingDialog';
import { SidePanel } from './SidePanel';

export const ENTITY_PARAM = 'entity';

const SYNTHESIS_REQUEST_TIMEOUT_MS = 120_000;

export default function BrainScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedId = searchParams.get(ENTITY_PARAM);
  const [query, setQuery] = useState('');
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [card, setCard] = useState<EntityCardData | null>(null);
  const [entitiesLoaded, setEntitiesLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [synthesisRequest, setSynthesisRequest] = useState<SynthesisRequest | null>(null);
  const [recordingDialogOpen, setRecordingDialogOpen] = useState(false);
  const voiceOn = useModuleOn('voice');

  const selectedId = resolveSelection(entities, requestedId);
  const pendingSynthesisFor = synthesisRequest?.entityId ?? null;
  const refresh = () => setRefreshTick((tick) => tick + 1);

  const select = useCallback(
    (id: string) => setSearchParams({ [ENTITY_PARAM]: id }, { replace: true }),
    [setSearchParams],
  );

  useEffect(() => {
    invokeCmd<EntitySummary[]>('list_entities', { kind: null, q: query.trim() === '' ? null : query })
      .then((loaded) => {
        setEntities(loaded);
        setEntitiesLoaded(true);
        setListError(null);
      })
      .catch((reason: unknown) => {
        setListError(errorMessage(reason));
        setEntitiesLoaded(true);
      });
  }, [query, refreshTick]);

  useEffect(() => {
    if (selectedId === null) {
      return;
    }
    invokeCmd<EntityCardData>('get_entity_card', { id: selectedId })
      .then((loaded) => {
        setCard(loaded);
        setCardError(null);
        setSynthesisRequest((current) => settleSynthesisRequest(current, loaded));
      })
      .catch((reason: unknown) => {
        setCard(null);
        setCardError(errorMessage(reason));
      });
  }, [selectedId, refreshTick]);

  useEffect(() => {
    const onChange = () => setRefreshTick((tick) => tick + 1);
    const stops = [
      onRegisEvent('job.updated', onChange),
      onRegisEvent('sync.progress', onChange),
      onRegisEvent('index.progress', onChange),
    ];
    return () => {
      for (const stop of stops) {
        void stop.then((unlisten) => unlisten());
      }
    };
  }, []);

  useEffect(() => {
    if (pendingSynthesisFor === null) {
      return;
    }
    const timer = window.setTimeout(() => setSynthesisRequest(null), SYNTHESIS_REQUEST_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pendingSynthesisFor]);

  const decideFact = (factId: string, status: 'confirmed' | 'rejected') => {
    invokeCmd('set_fact_status', { id: factId, status })
      .then(refresh)
      .catch((reason: unknown) => setCardError(errorMessage(reason)));
  };

  const refreshSynthesis = () => {
    if (!card) {
      return;
    }
    setSynthesisRequest({
      entityId: card.entity.id,
      baseline: card.synthesis?.generatedAt ?? null,
      seenRunning: false,
    });
    sidecarCall('brain.synthesize', { entityId: card.entity.id }).catch((reason: unknown) => {
      setSynthesisRequest(null);
      setCardError(errorMessage(reason));
    });
  };

  const addNote = async (text: string): Promise<void> => {
    if (!card) {
      return;
    }
    try {
      await invokeCmd('add_entity_note', { entityId: card.entity.id, text });
      refresh();
    } catch (reason: unknown) {
      setCardError(errorMessage(reason));
      throw reason;
    }
  };

  const shownCard = card !== null && card.entity.id === selectedId ? card : null;

  return (
    <>
      <PageHeader
        title="Cerveau"
        actions={
          voiceOn && (
            <button type="button" className={controls.secondary} onClick={() => setRecordingDialogOpen(true)}>
              Nouvel enregistrement
            </button>
          )
        }
      />
      <div className={styles.layout}>
        <EntityList
          entities={entities}
          selectedId={selectedId}
          query={query}
          error={listError}
          onQueryChange={setQuery}
          onSelect={select}
        />
        <div className={styles.main}>
          <ErrorMessage>{cardError}</ErrorMessage>
          {shownCard && (
            <EntityCard
              card={shownCard}
              synthesisRequested={pendingSynthesisFor === shownCard.entity.id}
              onDecideFact={decideFact}
              onRefreshSynthesis={refreshSynthesis}
            />
          )}
          {!shownCard && !cardError && (!entitiesLoaded || selectedId !== null) && <Loading />}
          {!shownCard && !cardError && entitiesLoaded && selectedId === null && (
            <p className={styles.empty}>Sélectionne une entité.</p>
          )}
        </div>
        {shownCard && (
          <SidePanel
            entityId={shownCard.entity.id}
            notes={shownCard.notes}
            links={
              shownCard.entity.kind === 'project'
                ? shownCard.links
                : shownCard.links.filter((link) => link.entity.kind !== 'project')
            }
            onAddNote={addNote}
          />
        )}
      </div>
      {voiceOn && recordingDialogOpen && (
        <NewRecordingDialog defaultEntityId={selectedId} onClose={() => setRecordingDialogOpen(false)} />
      )}
    </>
  );
}
