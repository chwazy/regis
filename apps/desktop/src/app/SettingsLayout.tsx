import { NavLink, Outlet } from 'react-router';
import { SETTINGS_ITEMS } from './routes';
import styles from './SettingsLayout.module.css';

export function SettingsLayout() {
  return (
    <div className={styles.layout}>
      <nav aria-label="Sections des réglages" className={styles.nav}>
        <span className={styles.navTitle}>Réglages</span>
        {SETTINGS_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end
            className={({ isActive }) => (isActive ? styles.linkOn : styles.link)}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className={styles.page}>
        <Outlet />
      </div>
    </div>
  );
}
