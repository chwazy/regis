import controls from '../../components/ui/controls.module.css';
import { progressPercent } from '../../lib/update';
import { checkForUpdate, installUpdate, useUpdate, type UpdateSnapshot } from '../../lib/use-update';
import styles from './settings.module.css';

function statusLabel({ update, checking, checkedAt, installing, progress, error }: UpdateSnapshot): string {
  if (installing && update !== null) {
    const percent = progressPercent(progress);
    return `Téléchargement de la version ${update.version}${percent === null ? '…' : ` : ${percent} %`}`;
  }
  if (checking) {
    return 'Recherche en cours…';
  }
  if (update !== null) {
    return `Version ${update.version} disponible`;
  }
  if (checkedAt === null) {
    return 'Pas encore vérifié';
  }
  if (error !== null) {
    return 'Vérification impossible';
  }
  return `À jour (vérifié à ${new Date(checkedAt).toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' })})`;
}

export function UpdateStatus() {
  const state = useUpdate();
  const { update, checking, installing, error } = state;
  return (
    <div className={styles.field}>
      <span>{statusLabel(state)}</span>
      {error !== null && <span className={styles.error}>{error}</span>}
      <div className={styles.row}>
        <button
          type="button"
          className={controls.secondary}
          disabled={checking || installing}
          onClick={() => void checkForUpdate()}
        >
          Rechercher une mise à jour
        </button>
        {update !== null && (
          <button
            type="button"
            className={controls.primary}
            disabled={installing}
            onClick={() => void installUpdate()}
          >
            Installer et redémarrer
          </button>
        )}
      </div>
      {update?.notes != null && update.notes !== '' && <p className={styles.notes}>{update.notes}</p>}
    </div>
  );
}
