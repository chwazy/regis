import type { ScreenKey, UiScreens } from '../../lib/ui-screens';
import { PROFILES, type ProfileId } from './onboarding-model';
import styles from './onboarding.module.css';

const SCREEN_LABELS: { key: ScreenKey; label: string }[] = [
  { key: 'brief', label: 'Brief' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'brain', label: 'Cerveau' },
];

interface StepProfileProps {
  profileId: ProfileId;
  screens: UiScreens;
  onProfile: (id: ProfileId) => void;
  onScreens: (screens: UiScreens) => void;
}

export function StepProfile({ profileId, screens, onProfile, onScreens }: StepProfileProps) {
  return (
    <section className={styles.card} aria-labelledby="onboarding-profile">
      <h2 id="onboarding-profile" className={styles.title}>
        Votre profil d’usage
      </h2>
      <p className={styles.hint}>
        Un profil est un préréglage : vous pouvez ajuster les écrans ci-dessous, puis plus tard dans Réglages.
      </p>
      <div className={styles.profiles} role="radiogroup" aria-label="Profil d’usage">
        {PROFILES.map((profile) => (
          <label
            key={profile.id}
            className={profile.id === profileId ? styles.profileActive : styles.profile}
          >
            <input
              type="radio"
              name="onboarding-profile"
              value={profile.id}
              checked={profile.id === profileId}
              onChange={() => onProfile(profile.id)}
            />
            <span className={styles.profileTitle}>{profile.label}</span>
            <span className={styles.profileDescription}>{profile.description}</span>
          </label>
        ))}
      </div>
      <div className={styles.field}>
        <span className={styles.label}>Écrans visibles</span>
        <div className={styles.row}>
          {SCREEN_LABELS.map(({ key, label }) => (
            <label key={key} className={styles.check}>
              <input
                type="checkbox"
                checked={screens[key]}
                onChange={(event) => onScreens({ ...screens, [key]: event.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
        <span className={styles.hint}>
          Agents, Modèles &amp; sources et Connecteurs restent toujours accessibles.
        </span>
      </div>
    </section>
  );
}
