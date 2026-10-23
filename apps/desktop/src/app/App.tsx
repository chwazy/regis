import { Outlet, useLocation } from 'react-router';
import styles from './App.module.css';
import { ApprovalsReviewProvider } from './ApprovalsReviewProvider';
import { RecordingBanner } from '../components/RecordingBanner';
import { CommandPalette } from './CommandPalette';
import { NavBar } from './NavBar';
import { pageLayout } from './layout';

export function App() {
  const { pathname } = useLocation();
  const layout = pageLayout(pathname);
  return (
    <ApprovalsReviewProvider>
      <div className={styles.shell}>
        <NavBar />
        <RecordingBanner />
        <CommandPalette />
        <div className={styles.content}>
          <main className={styles.main} data-layout={layout}>
            <Outlet />
          </main>
        </div>
      </div>
    </ApprovalsReviewProvider>
  );
}
