import type { AgentRuntime } from '@regis/shared';
import { runtimeBadge, type RuntimeTone } from './agent-labels';
import styles from './agents.module.css';

const TONE_CLASSES: Record<RuntimeTone, string | undefined> = {
  cli: styles.badgeCli,
  api: styles.badgeApi,
  local: styles.badgeLocal,
  planned: styles.badgePlanned,
};

export function RuntimeBadge({ runtime, large = false }: { runtime: AgentRuntime; large?: boolean }) {
  const badge = runtimeBadge(runtime);
  return (
    <span
      className={`${TONE_CLASSES[badge.tone] ?? ''} ${large ? (styles.badgeLarge ?? '') : ''}`}
      aria-hidden="true"
    >
      {badge.initials}
    </span>
  );
}
