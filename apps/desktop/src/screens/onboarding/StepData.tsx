import { useMemo, useState } from 'react';
import type { AppSettingsInfo } from '@regis/shared';
import { invokeCmd } from '../../lib/ipc';
import { listTimezones } from '../../lib/timezones';
import { buildResumeUrl, type ProfileId } from './onboarding-model';
import styles from './onboarding.module.css';

interface StepDataProps {
  info: AppSettingsInfo | null;
  profileId: ProfileId;
  timezone: string;
  onTimezone: (timezone: string) => void;
}

export function StepData({ info, profileId, timezone, onTimezone }: StepDataProps) {
  const [dataDirInput, setDataDirInput] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timezones = useMemo(() => listTimezones(timezone), [timezone]);
  const locked = info?.dataDirOrigin === 'env';

  const changeDataDir = () => {
    setRestarting(true);
    setError(null);
    invokeCmd<void>('set_data_dir', {
      path: dataDirInput,
      resumeUrl: buildResumeUrl(profileId, 'data'),
    }).catch((reason: unknown) => {
      setRestarting(false);
      setError(String(reason));
    });
  };

  return (
    <section className={styles.card} aria-labelledby="onboarding-data">
      <h2 id="onboarding-data" className={styles.title}>
        Données &amp; fuseau horaire
      </h2>
      <div className={styles.field}>
        <label htmlFor="onboarding-timezone" className={styles.label}>
          Fuseau horaire
        </label>
        <select
          id="onboarding-timezone"
          className={styles.select}
          value={timezone}
          onChange={(event) => onTimezone(event.target.value)}
        >
          {timezones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        <span className={styles.hint}>Sert à calculer « aujourd’hui » et « la semaine ».</span>
      </div>
      <div className={styles.field}>
        <span className={styles.label}>Dossier de données</span>
        <span className={styles.mono}>{info?.dataDir ?? '…'}</span>
        <span className={styles.hint}>
          {locked
            ? 'Le dossier est imposé par la variable REGIS_DATA_DIR.'
            : 'Changer de dossier redémarre l’application sur une nouvelle base, sans déplacer vos données : l’assistant reprend à cette étape.'}
        </span>
        <div className={styles.row}>
          <label htmlFor="onboarding-data-dir" className={styles.label}>
            Utiliser un autre dossier
          </label>
          <input
            id="onboarding-data-dir"
            className={styles.input}
            type="text"
            value={dataDirInput}
            disabled={locked || restarting}
            onChange={(event) => setDataDirInput(event.target.value)}
          />
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={locked || restarting || dataDirInput.trim() === ''}
            onClick={changeDataDir}
          >
            Changer et redémarrer
          </button>
        </div>
        {error !== null && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
