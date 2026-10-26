import controls from './ui/controls.module.css';
import { progressPercent, shouldShowUpdateBanner } from '../lib/update';
import { dismissUpdate, installUpdate, useUpdate } from '../lib/use-update';
import styles from './UpdateBanner.module.css';

export function UpdateBanner() {
  const { update, dismissedVersion, installing, progress, error } = useUpdate();
  if (update === null || (!installing && !shouldShowUpdateBanner(update, dismissedVersion))) {
    return null;
  }
  const percent = progressPercent(progress);
  return (
    <div role="status" aria-live="polite" className={styles.banner}>
      <span className={styles.label}>
        {installing
          ? `Téléchargement de la version ${update.version}${percent === null ? '…' : ` : ${percent} %`}`
          : `Mise à jour ${update.version} disponible`}
      </span>
      {!installing && <span className={styles.current}>Version actuelle : {update.currentVersion}</span>}
      {error !== null && <span className={styles.error}>{error}</span>}
      {!installing && (
        <div className={styles.actions}>
          <button type="button" className={controls.primarySm} onClick={() => void installUpdate()}>
            Installer et redémarrer
          </button>
          <button
            type="button"
            className={controls.ghostSm}
            onClick={() => void dismissUpdate(update.version)}
          >
            Masquer
          </button>
        </div>
      )}
    </div>
  );
}
