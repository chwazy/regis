import type { JobStatus } from '@regis/shared';
import { STATUS_LABELS, STATUS_TONES } from '../screens/job/job-view';
import { StatusPill } from './ui/StatusPill';

export function JobStatusPill({ status }: { status: JobStatus }) {
  return (
    <StatusPill tone={STATUS_TONES[status]} dot pulse={status === 'running'}>
      {STATUS_LABELS[status]}
    </StatusPill>
  );
}
