import { useState } from 'react';
import { Link } from 'react-router';
import type { EntityCard } from '@regis/shared';
import { JoinMeetingButton } from '../../components/JoinMeetingButton';
import { Tabs } from '../../components/ui/Tabs';
import { tabPanelProps } from '../../components/ui/tab-panel';
import { formatDay, formatHours } from '../../lib/format';
import { entityPath } from '../../lib/paths';
import { useTimezone } from '../../lib/use-timezone';
import { transcriptLinkState } from '../transcript/transcript-view';
import { RESOURCE_KIND_LABELS, TIMELINE_KIND_LABELS, timelineAnchor, timelineTarget } from './brain-view';
import styles from './brain.module.css';

type ActivityTab = 'timeline' | 'projects' | 'documents' | 'resources';

const ID_PREFIX = 'activity';

export function ActivityTabs({ card }: { card: EntityCard }) {
  const [tab, setTab] = useState<ActivityTab>('timeline');
  const timezone = useTimezone();
  const items = [
    { id: 'timeline', label: <TabLabel text="Historique" count={card.timeline.length} /> },
    { id: 'projects', label: <TabLabel text="Projets" count={card.projects.length} /> },
    { id: 'documents', label: <TabLabel text="Documents" count={card.documents.length} /> },
    { id: 'resources', label: <TabLabel text="Ressources" count={card.resources.length} /> },
  ] as const;

  return (
    <section aria-label="Activité" className={styles.activity}>
      <Tabs idPrefix={ID_PREFIX} label="Activité" items={items} value={tab} onChange={setTab} />
      <div {...tabPanelProps(ID_PREFIX, tab)} className={styles.activityScroll}>
        {tab === 'timeline' && (
          <>
            {card.timeline.length === 0 && <p className={styles.empty}>Rien pour l’instant.</p>}
            {card.timeline.map((entry) => {
              const target = timelineTarget(entry, card.notes);
              return (
                <div
                  key={`${entry.kind}-${entry.id}`}
                  id={timelineAnchor(entry.id)}
                  className={styles.timelineRow}
                >
                  <span className={styles.timelineDate}>{formatDay(entry.at, timezone)}</span>
                  <span className={styles.timelineKind}>
                    {TIMELINE_KIND_LABELS[entry.kind] ?? entry.kind}
                  </span>
                  {target === null ? (
                    <span className={styles.timelineText}>{entry.text}</span>
                  ) : (
                    <Link
                      className={styles.timelineLink}
                      to={target}
                      state={transcriptLinkState(card.entity.id)}
                    >
                      {entry.text}
                    </Link>
                  )}
                  {entry.item && <JoinMeetingButton event={entry.item} />}
                </div>
              );
            })}
          </>
        )}
        {tab === 'projects' && (
          <>
            {card.projects.length === 0 && <p className={styles.empty}>Aucun projet.</p>}
            {card.projects.map((project) => (
              <div key={project.entity.id} className={styles.row}>
                <Link className={styles.rowLink} to={entityPath(project.entity.id)}>
                  {project.entity.name}
                </Link>
                <span className={styles.rowEnd}>{formatHours(project.hoursLogged)} saisies</span>
              </div>
            ))}
          </>
        )}
        {tab === 'documents' && (
          <>
            {card.documents.length === 0 && <p className={styles.empty}>Aucun document lié.</p>}
            {card.documents.map((document) => (
              <div key={document.fileId} className={styles.row}>
                <span className={styles.ext}>{document.ext.toUpperCase() || '—'}</span>
                <span className={styles.rowLabel}>{document.name}</span>
                <span className={styles.rowEndText}>{document.origin === 'auto' ? 'Auto' : 'Lié'}</span>
              </div>
            ))}
          </>
        )}
        {tab === 'resources' && (
          <>
            {card.resources.length === 0 && <p className={styles.empty}>Aucune ressource rattachée.</p>}
            {card.resources.map((resource) => (
              <div key={resource.id} className={styles.row}>
                <span className={styles.timelineKind}>{RESOURCE_KIND_LABELS[resource.kind]}</span>
                <span className={styles.rowLabel}>{resource.label ?? resource.value}</span>
                {resource.label && <span className={styles.rowEndText}>{resource.value}</span>}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function TabLabel({ text, count }: { text: string; count: number }) {
  return (
    <>
      {text}
      <span className={styles.tabCount}>{count}</span>
    </>
  );
}
