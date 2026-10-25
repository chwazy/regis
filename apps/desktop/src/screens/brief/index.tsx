import { useCallback, useEffect, useState } from 'react';
import type { Agent, Brief, BriefData, HourSuggestion, Job } from '@regis/shared';
import { ChatPanel } from '../../components/ChatPanel';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import { setChatJobId, useChatJobId } from '../../lib/chat-session';
import { errorMessage } from '../../lib/format';
import { invokeCmd, onRegisEvent, sidecarCall } from '../../lib/ipc';
import { useTimezone } from '../../lib/use-timezone';
import { AgendaSection } from './AgendaSection';
import { ApprovalsSection } from './ApprovalsSection';
import { HoursSection } from './HoursSection';
import { JobsSection } from './JobsSection';
import { MailsSection } from './MailsSection';
import { Summary } from './Summary';
import { timesheetJobPrompt, timesheetJobTitle } from './brief-view';
import styles from './brief.module.css';

const GENERATE_TIMEOUT_SECS = 900;
const REFRESH_TOPICS = [
  'brief.ready',
  'approval.created',
  'approval.resolved',
  'job.updated',
  'sync.progress',
] as const;

function useBriefScreen() {
  const [data, setData] = useState<BriefData | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const timezone = useTimezone();
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([
      sidecarCall<BriefData>('brief.data'),
      sidecarCall<Brief | null>('brief.get', {}),
      invokeCmd<Agent[]>('list_agents'),
    ])
      .then(([loadedData, loadedBrief, loadedAgents]) => {
        setData(loadedData);
        setBrief(loadedBrief);
        setAgents(loadedAgents);
        setError(null);
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  useEffect(() => {
    reload();
    const unlisteners = REFRESH_TOPICS.map((topic) => onRegisEvent(topic, reload));
    return () => {
      for (const unlistener of unlisteners) {
        void unlistener.then((stop) => stop());
      }
    };
  }, [reload]);

  return { data, brief, agents, timezone, error, setError, reload };
}

export default function BriefScreen() {
  const { data, brief, agents, timezone, error, setError, reload } = useBriefScreen();
  const [regenerating, setRegenerating] = useState(false);
  const [submitted, setSubmitted] = useState<ReadonlySet<string>>(new Set());
  const chatJobId = useChatJobId();

  const regenerate = () => {
    setRegenerating(true);
    sidecarCall<Brief>('brief.generate', { force: true }, GENERATE_TIMEOUT_SECS)
      .then(reload)
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setRegenerating(false));
  };

  const submitHours = (suggestion: HourSuggestion) => {
    setSubmitted((current) => new Set(current).add(suggestion.eventItemId));
    sidecarCall<Job>('jobs.start', {
      title: timesheetJobTitle(suggestion),
      prompt: timesheetJobPrompt(suggestion),
      kind: 'task',
      source: 'brief',
    })
      .then(reload)
      .catch((reason: unknown) => {
        setSubmitted((current) => {
          const next = new Set(current);
          next.delete(suggestion.eventItemId);
          return next;
        });
        setError(errorMessage(reason));
      });
  };

  const sendQuickAction = (text: string) => {
    sidecarCall<Job>('chat.send', { text, ...(chatJobId === null ? {} : { chatJobId }) })
      .then((job) => setChatJobId(job.id))
      .catch((reason: unknown) => setError(errorMessage(reason)));
  };

  return (
    <div className={styles.layout}>
      <div className={styles.content}>
        <ErrorMessage>{error}</ErrorMessage>
        {data === null && error === null && <Loading />}
        {data && (
          <>
            <Summary
              data={data}
              brief={brief}
              regenerating={regenerating}
              onRegenerate={regenerate}
              onChip={sendQuickAction}
            />
            <div className={styles.grid}>
              <ApprovalsSection approvals={data.pendingApprovals} />
              <MailsSection mails={data.unreadMails} now={new Date()} timezone={timezone} />
              <AgendaSection events={data.todayEvents} timezone={timezone} />
              <HoursSection data={data} submitted={submitted} onSubmit={submitHours} />
              <JobsSection jobs={data.activeJobs} agents={agents} />
            </div>
          </>
        )}
      </div>
      <div className={styles.assistant}>
        <ChatPanel key={chatJobId ?? 'new'} chatJobId={chatJobId} onChatJobChange={setChatJobId} />
      </div>
    </div>
  );
}
