import { useEffect, useState } from 'react';
import type { Agent, Connector, FileSourceInfo, PrereqReport } from '@regis/shared';
import { invokeCmd, sidecarCall } from '../../lib/ipc';
import type { UiScreens } from '../../lib/ui-screens';
import type { DefaultWrite } from './StepAgents';
import type { Profile } from './onboarding-model';
import styles from './onboarding.module.css';

interface StepSummaryProps {
  profile: Profile;
  screens: UiScreens;
  timezone: string;
  defaultAgentId: string;
  defaultWrite: DefaultWrite;
}

interface Snapshot {
  report: PrereqReport | null;
  connectors: Connector[];
  sources: FileSourceInfo[];
  agents: Agent[];
}

interface Line {
  label: string;
  value: string;
  done: boolean;
}

const SCREEN_NAMES: [keyof UiScreens, string][] = [
  ['brief', 'Brief'],
  ['dashboard', 'Dashboard'],
  ['brain', 'Cerveau'],
];

export function StepSummary({ profile, screens, timezone, defaultAgentId, defaultWrite }: StepSummaryProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      sidecarCall<PrereqReport>('prereqs.check', {}).catch(() => null),
      invokeCmd<Connector[]>('list_connectors').catch(() => []),
      invokeCmd<FileSourceInfo[]>('list_file_sources').catch(() => []),
      invokeCmd<Agent[]>('list_agents').catch(() => []),
    ]).then(([report, connectors, sources, agents]) => {
      if (active) {
        setSnapshot({ report, connectors, sources, agents });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (snapshot === null) {
    return (
      <section className={styles.card} aria-labelledby="onboarding-summary">
        <h2 id="onboarding-summary" className={styles.title}>
          Récapitulatif
        </h2>
        <p className={styles.hint}>Chargement…</p>
      </section>
    );
  }

  const lines: Line[] = [
    { label: 'Profil', value: profile.label, done: true },
    {
      label: 'Écrans visibles',
      value:
        SCREEN_NAMES.filter(([key]) => screens[key])
          .map(([, name]) => name)
          .join(', ') || 'Aucun',
      done: true,
    },
    { label: 'Fuseau horaire', value: timezone, done: true },
  ];

  for (const item of snapshot.report?.items ?? []) {
    const required = item.required && screens.brain;
    lines.push({
      label: item.label,
      value: item.state === 'ok' ? 'OK' : `${item.detail}${required ? ' (requis)' : ''}`,
      done: item.state === 'ok' || !required,
    });
  }

  const kinds: Record<string, string> = { m365: 'Microsoft 365', odoo: 'Odoo' };
  for (const step of profile.connectorSteps) {
    if (step === 'files') {
      const count = snapshot.sources.length;
      lines.push({
        label: 'Sources de fichiers',
        value: count > 0 ? `${count} source(s)` : 'À faire : ajouter un dossier',
        done: count > 0,
      });
    } else {
      const found = snapshot.connectors.some((connector) => connector.kind === step);
      lines.push({
        label: kinds[step] ?? step,
        value: found ? 'Configuré' : 'À faire dans Connecteurs',
        done: found,
      });
    }
  }

  const agent = snapshot.agents.find((candidate) => candidate.id === defaultAgentId);
  lines.push({
    label: 'Agent par défaut',
    value: agent ? agent.name : 'À faire : activer un agent',
    done: agent !== undefined,
  });
  lines.push({
    label: 'Écritures non réglées',
    value: defaultWrite === 'deny' ? 'Interdire' : 'Demander',
    done: true,
  });

  return (
    <section className={styles.card} aria-labelledby="onboarding-summary">
      <h2 id="onboarding-summary" className={styles.title}>
        Récapitulatif
      </h2>
      <p className={styles.hint}>
        Ce qui reste à faire pourra être complété plus tard dans Réglages, Connecteurs et Agents.
      </p>
      <ul className={styles.summaryList}>
        {lines.map((line) => (
          <li key={line.label} className={styles.summaryItem}>
            <span className={styles.summaryLabel}>{line.label}</span>
            <span className={line.done ? styles.ok : styles.warn}>{line.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
