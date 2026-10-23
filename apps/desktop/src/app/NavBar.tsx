import { NavLink, useLocation } from 'react-router';
import { useUiScreens } from '../lib/use-ui-screens';
import { PresenceMark } from '../components/PresenceMark';
import { presenceState } from '../components/presence-state';
import { useApprovalsReview } from './approvals-review';
import { ApprovalsPanel } from './ApprovalsPanel';
import { isNavActive } from './layout';
import styles from './NavBar.module.css';
import { OPEN_PALETTE_EVENT } from './palette-model';
import { NAV_ITEMS } from './routes';
import { SettingsMenu } from './SettingsMenu';

export function NavBar() {
  const { pending } = useApprovalsReview();
  const { screens } = useUiScreens();
  const { pathname } = useLocation();
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <PresenceMark state={presenceState({ pendingApprovals: pending.length })} />
        <span className={styles.brandName}>Régis</span>
      </div>
      <nav aria-label="Navigation principale" className={styles.nav}>
        {NAV_ITEMS.filter((item) => item.screen === undefined || screens[item.screen]).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end
            className={isNavActive(item, pathname) ? `${styles.link} ${styles.active}` : styles.link}
            aria-current={isNavActive(item, pathname) ? 'page' : undefined}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <button
        type="button"
        className={styles.search}
        onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
      >
        Rechercher clients, projets, fichiers…
        <kbd className={styles.shortcut}>Ctrl K</kbd>
      </button>
      <ApprovalsPanel />
      <SettingsMenu />
    </header>
  );
}
