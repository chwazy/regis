import type { JobStatus } from '@regis/shared';
import { JobStatusPill } from '../components/JobStatusPill';
import { formatUsd } from '../lib/format';
import { jobPath } from '../lib/paths';
import { STATUS_LABELS } from '../screens/job/job-view';
import type { JobsData } from './data';
import { Big, Row, WidgetData, type NoConfig, type WidgetProps } from './parts';
import { useCacheWidget } from './use-widget-data';

function isJobStatus(status: string): status is JobStatus {
  return Object.hasOwn(STATUS_LABELS, status);
}

export function JobsWidget({ config }: WidgetProps<NoConfig>) {
  const state = useCacheWidget<JobsData>('jobs', config);
  return (
    <WidgetData state={state}>
      {(data) => (
        <>
          <Big>{data.activeCount} en cours</Big>
          {data.active.map((job) => (
            <Row
              key={job.id}
              label={job.title}
              value={isJobStatus(job.status) ? <JobStatusPill status={job.status} /> : job.status}
              to={jobPath(job.id)}
            />
          ))}
          <Row label="Coût du jour" value={formatUsd(data.costTodayUsd)} />
        </>
      )}
    </WidgetData>
  );
}
