import { useState } from 'react';
import { Link } from 'react-router';
import type { Agent, Job } from '@regis/shared';
import { JobStatusPill } from '../../components/JobStatusPill';
import card from '../../components/ui/card.module.css';
import controls from '../../components/ui/controls.module.css';
import { Dialog } from '../../components/ui/Dialog';
import dialog from '../../components/ui/dialog.module.css';
import { formatClock } from '../../lib/format';
import { jobPath } from '../../lib/paths';
import { formatDuration } from '../job/job-view';
import { HISTORY_PREVIEW_COUNT, jobCost } from './activity';
import styles from './activity.module.css';

interface HistoryProps {
  jobs: Job[];
  agents: Map<string, Agent>;
  now: Date;
  timezone: string;
}

function FailedFilter({
  failedOnly,
  onChange,
}: {
  failedOnly: boolean;
  onChange: (failedOnly: boolean) => void;
}) {
  return (
    <div className={styles.filterGroup} role="group" aria-label="Filtrer l’historique">
      <button
        type="button"
        className={failedOnly ? controls.chip : controls.chipOn}
        aria-pressed={!failedOnly}
        onClick={() => onChange(false)}
      >
        Tout
      </button>
      <button
        type="button"
        className={failedOnly ? controls.chipOn : controls.chip}
        aria-pressed={failedOnly}
        onClick={() => onChange(true)}
      >
        Échecs
      </button>
    </div>
  );
}

function emptyLabel(failedOnly: boolean): string {
  return failedOnly ? 'Aucun échec aujourd’hui.' : 'Aucune tâche terminée aujourd’hui.';
}

function HistoryDialog({ jobs, agents, now, timezone, onClose }: HistoryProps & { onClose: () => void }) {
  const [failedOnly, setFailedOnly] = useState(false);
  const visible = failedOnly ? jobs.filter((job) => job.status === 'failed') : jobs;

  return (
    <Dialog labelledBy="history-dialog-title" size="lg" onClose={onClose}>
      <div className={dialog.head}>
        <h2 id="history-dialog-title" className={dialog.title}>
          Aujourd’hui
        </h2>
        <span className={card.count}>{jobs.length}</span>
        <div className={card.right}>
          <FailedFilter failedOnly={failedOnly} onChange={setFailedOnly} />
          <button type="button" className={controls.secondarySm} onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
      {visible.length === 0 ? (
        <p className={card.empty}>{emptyLabel(failedOnly)}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Tâche</th>
                <th scope="col">Agent</th>
                <th scope="col">Statut</th>
                <th scope="col" className={styles.num}>
                  Durée
                </th>
                <th scope="col" className={styles.num}>
                  Coût
                </th>
                <th scope="col" className={styles.num}>
                  Fin
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((job) => {
                const agent = agents.get(job.agentId);
                return (
                  <tr key={job.id}>
                    <td>
                      <Link to={jobPath(job.id)} className={controls.link}>
                        {job.title}
                      </Link>
                    </td>
                    <td>{agent?.name ?? job.agentId}</td>
                    <td>
                      <JobStatusPill status={job.status} />
                    </td>
                    <td className={styles.num}>
                      {formatDuration(job.startedAt, job.endedAt, now.getTime())}
                    </td>
                    <td className={styles.num}>{jobCost(job, agent)}</td>
                    <td className={styles.num}>{formatClock(job.endedAt, timezone)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

export function HistoryCard({ jobs, agents, now, timezone }: HistoryProps) {
  const [failedOnly, setFailedOnly] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const filtered = failedOnly ? jobs.filter((job) => job.status === 'failed') : jobs;
  const preview = filtered.slice(0, HISTORY_PREVIEW_COUNT);

  return (
    <section aria-label="Historique du jour" className={card.card}>
      <div className={card.head}>
        <h2 className={card.title}>Aujourd’hui</h2>
        <span className={card.count}>{jobs.length}</span>
        <div className={card.right}>
          <FailedFilter failedOnly={failedOnly} onChange={setFailedOnly} />
        </div>
      </div>
      {preview.length === 0 && <p className={card.empty}>{emptyLabel(failedOnly)}</p>}
      <ul className={styles.historyList}>
        {preview.map((job) => {
          const agent = agents.get(job.agentId);
          return (
            <li key={job.id} className={styles.historyItem}>
              <div className={styles.historyTop}>
                <Link to={jobPath(job.id)} className={`${controls.link} ${styles.ellipsis}`}>
                  {job.title}
                </Link>
                <JobStatusPill status={job.status} />
              </div>
              <div className={styles.meta}>
                <span>{agent?.name ?? job.agentId}</span>
                <span className={styles.mono}>
                  {formatDuration(job.startedAt, job.endedAt, now.getTime())}
                </span>
                <span className={styles.mono}>{jobCost(job, agent)}</span>
                {job.endedAt && <span className={styles.mono}>{formatClock(job.endedAt, timezone)}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {filtered.length > HISTORY_PREVIEW_COUNT && (
        <div className={card.foot}>
          <button type="button" className={controls.link} onClick={() => setExpanded(true)}>
            Tout afficher ({filtered.length}) →
          </button>
        </div>
      )}
      {expanded && (
        <HistoryDialog
          jobs={jobs}
          agents={agents}
          now={now}
          timezone={timezone}
          onClose={() => setExpanded(false)}
        />
      )}
    </section>
  );
}
