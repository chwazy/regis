export type RegisTopic =
  | 'sidecar.status'
  | 'job.updated'
  | 'job.event'
  | 'approval.created'
  | 'approval.resolved'
  | 'connector.status'
  | 'sync.progress'
  | 'index.progress'
  | 'brief.ready'
  | 'module.download.progress'
  | 'module.backfill.progress'
  | 'dictation.level'
  | 'dictation.autoStopped'
  | 'recording.state'
  | 'recording.segment'
  | 'recording.level'
  | 'recording.backlog'
  | 'settings.changed';
export interface RegisEvent<T = unknown> {
  topic: RegisTopic;
  payload: T;
  at: string;
}
export const REGIS_EVENT_CHANNEL = 'regis://event';
