import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { getVersion } from '@tauri-apps/api/app';
import type { AppSettingsInfo } from '@regis/shared';
import { LocalModuleRow } from '../../components/LocalModuleRow';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { PageHeader } from '../../components/ui/PageHeader';
import { DEFAULT_TIMEZONE, errorMessage } from '../../lib/format';
import { invokeCmd } from '../../lib/ipc';
import { listTimezones } from '../../lib/timezones';
import { useLocalModules } from '../../lib/use-local-modules';
import { invalidateTimezone } from '../../lib/use-timezone';
import { isTauri } from '@tauri-apps/api/core';
import {
  DEFAULT_UI_SCREENS,
  parseUiScreens,
  UI_SCREENS_KEY,
  type ScreenKey,
  type UiScreens,
} from '../../lib/ui-screens';
import styles from './settings.module.css';
import { UpdateStatus } from './UpdateStatus';

const TIMEZONE_KEY = 'app.timezone';
const DEFAULT_WRITE_KEY = 'policy.defaultWrite';

const SCREEN_LABELS: { key: ScreenKey; label: string }[] = [
  { key: 'brief', label: 'Brief' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'brain', label: 'Cerveau' },
];

const ORIGIN_LABELS: Record<AppSettingsInfo['dataDirOrigin'], string> = {
  env: 'Variable REGIS_DATA_DIR',
  bootstrap: 'Choix de l’utilisateur',
  default: 'Par défaut',
};

type DefaultWriteChoice = 'ask' | 'deny';

export default function SettingsScreen() {
  const navigate = useNavigate();
  const { modules } = useLocalModules();
  const [info, setInfo] = useState<AppSettingsInfo | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [screens, setScreens] = useState<UiScreens>(DEFAULT_UI_SCREENS);
  const [defaultWrite, setDefaultWrite] = useState<DefaultWriteChoice>('ask');
  const [dataDirInput, setDataDirInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    Promise.all([
      invokeCmd<AppSettingsInfo>('get_app_info'),
      invokeCmd<string | null>('get_setting', { key: TIMEZONE_KEY }),
      invokeCmd<string | null>('get_setting', { key: UI_SCREENS_KEY }),
      invokeCmd<string | null>('get_setting', { key: DEFAULT_WRITE_KEY }),
    ])
      .then(([loadedInfo, tz, rawScreens, rawWrite]) => {
        setInfo(loadedInfo);
        setDataDirInput(loadedInfo.dataDir);
        setTimezone(tz !== null && tz !== '' ? tz : DEFAULT_TIMEZONE);
        setScreens(parseUiScreens(rawScreens));
        setDefaultWrite(rawWrite === 'deny' ? 'deny' : 'ask');
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
    if (isTauri()) {
      getVersion()
        .then(setAppVersion)
        .catch(() => setAppVersion(null));
    }
  }, []);

  const save = useCallback(async (key: string, value: string, apply: () => void) => {
    try {
      await invokeCmd<void>('set_setting', { key, value });
      apply();
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, []);

  const timezones = useMemo(() => listTimezones(timezone), [timezone]);

  const toggleScreen = (key: ScreenKey, visible: boolean) => {
    const next = { ...screens, [key]: visible };
    void save(UI_SCREENS_KEY, JSON.stringify(next), () => setScreens(next));
  };

  const changeDataDir = () => {
    setRestarting(true);
    invokeCmd<void>('set_data_dir', { path: dataDirInput })
      .then(() => setError(null))
      .catch((reason: unknown) => {
        setRestarting(false);
        setError(errorMessage(reason));
      });
  };

  const locked = info?.dataDirOrigin === 'env';

  return (
    <div className={styles.page}>
      <PageHeader title="Général" subtitle="Fuseau horaire, écrans, politique par défaut et données." />
      <ErrorMessage>{error}</ErrorMessage>

      <section className={styles.card} aria-labelledby="settings-general">
        <h2 id="settings-general" className={styles.title}>
          Préférences
        </h2>
        <div className={styles.field}>
          <label htmlFor="settings-timezone" className={controls.label}>
            Fuseau horaire
          </label>
          <select
            id="settings-timezone"
            className={`${controls.select} ${styles.select}`}
            value={timezone}
            onChange={(event) => {
              const value = event.target.value;
              void save(TIMEZONE_KEY, value, () => {
                setTimezone(value);
                invalidateTimezone();
              });
            }}
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <span className={controls.label}>Dossier de données</span>
          <span className={styles.mono}>{info?.dataDir ?? '…'}</span>
          <span className={styles.hint}>
            Origine : {info ? ORIGIN_LABELS[info.dataDirOrigin] : '…'}. Le changement ne déplace aucune donnée
            : l’ancien dossier reste intact.
          </span>
          <div className={styles.row}>
            <label htmlFor="settings-data-dir" className="sr-only">
              Nouveau dossier de données
            </label>
            <input
              id="settings-data-dir"
              className={`${controls.input} ${styles.input}`}
              type="text"
              value={dataDirInput}
              disabled={locked || restarting}
              onChange={(event) => setDataDirInput(event.target.value)}
            />
            <button
              type="button"
              className={controls.primary}
              disabled={locked || restarting || dataDirInput.trim() === ''}
              onClick={changeDataDir}
            >
              Changer et redémarrer
            </button>
          </div>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="settings-modules">
        <h2 id="settings-modules" className={styles.title}>
          Modules locaux
        </h2>
        <p className={styles.hint}>
          Désactivés par défaut : un module ne s’active qu’une fois son modèle prêt, téléchargé avec ton
          accord.
        </p>
        {modules.map((module) => (
          <LocalModuleRow key={module.id} module={module} />
        ))}
      </section>

      <section className={styles.card} aria-labelledby="settings-screens">
        <h2 id="settings-screens" className={styles.title}>
          Écrans
        </h2>
        <p className={styles.hint}>
          Agents, Modèles &amp; sources et Connecteurs restent toujours accessibles.
        </p>
        <div className={styles.row}>
          {SCREEN_LABELS.map(({ key, label }) => (
            <label key={key} className={styles.check}>
              <input
                type="checkbox"
                checked={screens[key]}
                onChange={(event) => toggleScreen(key, event.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
      </section>

      <section className={styles.card} aria-labelledby="settings-policy">
        <h2 id="settings-policy" className={styles.title}>
          Politique
        </h2>
        <div className={styles.field}>
          <label htmlFor="settings-default-write" className={controls.label}>
            Écritures non réglées
          </label>
          <select
            id="settings-default-write"
            className={`${controls.select} ${styles.select}`}
            value={defaultWrite}
            onChange={(event) => {
              const value: DefaultWriteChoice = event.target.value === 'deny' ? 'deny' : 'ask';
              void save(DEFAULT_WRITE_KEY, value, () => setDefaultWrite(value));
            }}
          >
            <option value="ask">Demander</option>
            <option value="deny">Interdire</option>
          </select>
          <span className={styles.hint}>
            S’applique aux outils d’écriture sans règle explicite. Les règles de la politique des outils
            gardent la priorité.
          </span>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="settings-onboarding">
        <h2 id="settings-onboarding" className={styles.title}>
          Assistant de première utilisation
        </h2>
        <p className={styles.hint}>
          Repasse par les étapes de configuration avec tes valeurs actuelles préremplies.
        </p>
        <div className={styles.row}>
          <button type="button" className={controls.primary} onClick={() => navigate('/bienvenue')}>
            Relancer l’assistant
          </button>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="settings-about">
        <h2 id="settings-about" className={styles.title}>
          À propos
        </h2>
        <dl className={styles.facts}>
          <dt>Version</dt>
          <dd>{appVersion ?? info?.version ?? '…'}</dd>
          <dt>Mises à jour</dt>
          <dd>
            <UpdateStatus />
          </dd>
          <dt>Dossier de données</dt>
          <dd className={styles.mono}>{info?.dataDir ?? '…'}</dd>
          <dt>Mode démo</dt>
          <dd>{info === null ? '…' : info.demo ? 'Oui' : 'Non'}</dd>
        </dl>
      </section>
    </div>
  );
}
