import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import type { Agent } from '@regis/shared';
import { jobPath } from '../../lib/paths';
import type { JobTreeNode } from './job-tree';
import { STATUS_LABELS, STATUS_TONES } from './job-view';
import styles from './job.module.css';

interface JobTreeProps {
  nodes: JobTreeNode[];
  currentId: string | undefined;
  agents: Agent[];
}

export function JobTree({ nodes, currentId, agents }: JobTreeProps) {
  const agentName = (agentId: string): string =>
    agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  return (
    <aside aria-label="Tâches actives et liées" className={styles.tree}>
      <span className={styles.treeTitle}>Tâches actives et liées</span>
      {nodes.length === 0 && <p className={styles.muted}>Aucune tâche active.</p>}
      {nodes.map(({ job, depth }) => (
        <Link
          key={job.id}
          to={jobPath(job.id)}
          aria-current={job.id === currentId ? 'page' : undefined}
          className={job.id === currentId ? styles.treeItemCurrent : styles.treeItem}
          style={{ '--depth': depth } as CSSProperties}
        >
          <span
            className={`${styles.dot} ${styles[`tone_${STATUS_TONES[job.status]}`] ?? ''}`}
            role="img"
            aria-label={STATUS_LABELS[job.status]}
          />
          <span className={styles.treeText}>
            <span className={styles.treeName}>{job.title}</span>
            <span className={styles.treeAgent}>{agentName(job.agentId)}</span>
          </span>
        </Link>
      ))}
    </aside>
  );
}
