import { Link } from 'react-router';
import type { Agent, Job } from '@regis/shared';
import { JobStatusPill } from '../../components/JobStatusPill';
import { jobPath } from '../../lib/paths';
import styles from './brief.module.css';

interface JobsSectionProps {
  jobs: Job[];
  agents: Agent[];
}

export function JobsSection({ jobs, agents }: JobsSectionProps) {
  const agentName = (agentId: string): string =>
    agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  return (
    <section aria-label="Tâches en cours" className={`${styles.card} ${styles.wide}`}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Tâches en cours</h2>
        <span className={styles.badge}>{jobs.length}</span>
      </div>
      {jobs.length === 0 && <p className={styles.empty}>Aucune tâche en cours.</p>}
      <ul className={styles.list}>
        {jobs.map((job) => (
          <li key={job.id}>
            <Link to={jobPath(job.id)} className={styles.jobLink}>
              <span className={styles.jobTitle}>{job.title}</span>
              <span className={styles.jobAgent}>{agentName(job.agentId)}</span>
              <JobStatusPill status={job.status} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
